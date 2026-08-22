import type { Logger } from "./logger.ts";
import { nanoid } from "./id.ts";

export interface SchedulerIncidentObserver {
  recordLoopFailure(task: string, error: unknown): Promise<void>;
  recordLoopSuccess(task: string): Promise<void>;
}

export class Scheduler {
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly running = new Map<string, Promise<void>>();
  private accepting = true;

  public constructor(
    private readonly logger: Logger,
    private readonly incidents?: SchedulerIncidentObserver,
  ) {}

  public every(name: string, intervalMs: number, task: () => Promise<void>): void {
    const run = () => {
      if (!this.accepting) return;
      if (this.running.has(name)) {
        this.logger.debug("scheduler.tick.skipped", "Scheduled task overlap skipped", { task: name });
        return;
      }
      const runId = nanoid();
      const startedAt = performance.now();
      const operation = this.logger.runWithContext({ task: name, runId }, async () => {
        this.logger.debug("scheduler.tick.started", "Scheduled task started", { intervalMs });
      try {
        await task();
        await this.incidents?.recordLoopSuccess(name);
        this.logger.debug("scheduler.tick.completed", "Scheduled task completed", {
          durationMs: Math.round(performance.now() - startedAt),
          outcome: "success",
        });
      } catch (error) {
        this.logger.error("scheduler.tick.failed", "Scheduled task failed", {
          error,
          durationMs: Math.round(performance.now() - startedAt),
          outcome: "failure",
        });
        await this.incidents?.recordLoopFailure(name, error).catch((incidentError) =>
          this.logger.error("scheduler.incident.failed", "Unable to record scheduled task incident", {
            error: incidentError,
          })
        );
      } finally {
        this.running.delete(name);
      }
      });
      this.running.set(name, operation);
    };
    this.timers.push(setInterval(run, intervalMs));
  }

  public async stop(graceMs = 10_000): Promise<void> {
    this.accepting = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    if (this.running.size === 0) return;
    const active = Promise.allSettled([...this.running.values()]);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      active,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, graceMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  }
}
