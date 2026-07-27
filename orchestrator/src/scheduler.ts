import type { Logger } from "./logger.ts";

export class Scheduler {
  private readonly timers: ReturnType<typeof setInterval>[] = [];

  public constructor(private readonly logger: Logger) {}

  public every(name: string, intervalMs: number, task: () => Promise<void>): void {
    // Detach the promise so interval scheduling is never blocked by a slow tick;
    // individual services are responsible for preventing overlapping executions.
    const run = () =>
      void task().catch((error) =>
        this.logger.error("Scheduled task failed", { task: name, error: String(error) }),
      );
    this.timers.push(setInterval(run, intervalMs));
  }

  public stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }
}
