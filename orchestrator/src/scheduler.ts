import type { Logger } from "./logger.ts";

export interface SchedulerIncidentObserver {
  recordLoopFailure(task: string, error: unknown): Promise<void>;
  recordLoopSuccess(task: string): Promise<void>;
}

export class Scheduler {
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly running = new Set<string>();

  public constructor(
    private readonly logger: Logger,
    private readonly incidents?: SchedulerIncidentObserver,
  ) {}

  public every(name: string, intervalMs: number, task: () => Promise<void>): void {
    // Detach the promise so interval scheduling is never blocked by a slow tick.
    // A skipped overlap is not a success: otherwise it would clear a pending
    // consecutive-failure incident while the previous invocation is still failing.
    const run = () => void (async () => {
      if (this.running.has(name)) return;
      this.running.add(name);
      try {
        await task();
        await this.incidents?.recordLoopSuccess(name);
      } catch (error) {
        this.logger.error("Scheduled task failed", { task: name, error: String(error) });
        await this.incidents?.recordLoopFailure(name, error).catch((incidentError) =>
          this.logger.error("Unable to record scheduled task incident", {
            task: name,
            error: String(incidentError),
          })
        );
      } finally {
        this.running.delete(name);
      }
    })();
    this.timers.push(setInterval(run, intervalMs));
  }

  public stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }
}
