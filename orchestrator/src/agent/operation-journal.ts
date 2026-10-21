import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export class StaleOperationError extends Error {
  public readonly status = 409;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Stable instance identities have one irreversible lifecycle: create(1), stop(2), delete(3). */
export class OperationJournal {
  private readonly db: Database;
  private readonly queues = new Map<string, Promise<unknown>>();

  public constructor(path = ":memory:") {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operations (instance_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, fingerprint TEXT NOT NULL)");
  }

  public run<T>(instanceId: string, generation: number, specification: unknown, task: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9_-]+$/.test(instanceId) || !Number.isSafeInteger(generation) || generation < 1 || generation > 3) {
      return Promise.reject(new StaleOperationError("Invalid instance operation"));
    }
    const fingerprint = createHash("sha256").update(canonical(specification)).digest("hex");
    const admit = this.db.transaction(() => {
      const current = this.db.query<{ generation: number; fingerprint: string }, [string]>("SELECT generation, fingerprint FROM operations WHERE instance_id = ?").get(instanceId);
      if (current && (generation < current.generation || (generation === current.generation && fingerprint !== current.fingerprint))) {
        throw new StaleOperationError("Instance operation was superseded or its specification differs");
      }
      this.db.query("INSERT INTO operations VALUES (?, ?, ?) ON CONFLICT(instance_id) DO UPDATE SET generation=excluded.generation, fingerprint=excluded.fingerprint")
        .run(instanceId, generation, fingerprint);
    });
    try { admit(); } catch (error) { return Promise.reject(error); }
    const assertCurrent = () => {
      const row = this.db.query<{ generation: number }, [string]>("SELECT generation FROM operations WHERE instance_id=?").get(instanceId);
      if (row?.generation !== generation) throw new StaleOperationError("Instance operation was superseded");
    };
    const previous = this.queues.get(instanceId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() => { assertCurrent(); return task(assertCurrent); });
    const settled = result.then(() => {}, () => {}).finally(() => { if (this.queues.get(instanceId) === settled) this.queues.delete(instanceId); });
    this.queues.set(instanceId, settled);
    return result;
  }

  public async close(): Promise<void> {
    await Promise.allSettled(this.queues.values());
    this.db.close();
  }
}
