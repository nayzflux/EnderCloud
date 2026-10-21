import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OperationJournal } from "../../src/agent/operation-journal.ts";

test("delete fences a delayed create, including after journal restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ec-journal-"));
  const file = join(root, "operations.sqlite");
  let journal = new OperationJournal(file);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const admitted = new Promise<void>(resolve => { started = resolve; });
  let created = false;
  const create = journal.run("instance", 1, { image: "game:1" }, async assertCurrent => {
    started(); await wait; assertCurrent(); created = true;
  });
  const outcome = create.then(() => null, error => error as Error);
  await admitted;
  const deleted = journal.run("instance", 3, { desired: "ABSENT" }, async () => {});
  release();
  expect((await outcome)?.message).toContain("superseded");
  await deleted;
  expect(created).toBe(false);
  await journal.close();
  journal = new OperationJournal(file);
  await expect(journal.run("instance", 1, { image: "game:1" }, async () => {})).rejects.toThrow("superseded");
  await journal.close();
  await rm(root, { recursive: true, force: true });
});

test("same generation accepts identical specifications and rejects contradictions", async () => {
  const journal = new OperationJournal();
  await journal.run("instance", 1, { b: 2, a: 1 }, async () => {});
  await journal.run("instance", 1, { a: 1, b: 2 }, async () => {});
  await expect(journal.run("instance", 1, { a: 9 }, async () => {})).rejects.toThrow("differs");
  await journal.close();
});
