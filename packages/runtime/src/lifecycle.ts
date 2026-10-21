/** Own resources from construction onward, including partial startup failures. */
export class ResourceScope {
  private readonly resources: Array<{ name: string; close: () => void | Promise<unknown> }> = [];
  private closing: Promise<void> | undefined;
  public defer(name: string, close: () => void | Promise<unknown>): void {
    if (this.closing) throw new Error("Cannot acquire resources during shutdown");
    this.resources.push({ name, close });
  }
  public close(timeoutMs = 20_000): Promise<void> {
    return (this.closing ??= this.dispose(timeoutMs));
  }
  private async dispose(timeoutMs: number): Promise<void> {
    const errors: unknown[] = [];
    const deadline = Date.now() + timeoutMs;
    for (const resource of this.resources.reverse()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(resource.close),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Timed out closing ${resource.name}`)),
              Math.max(1, deadline - Date.now()),
            );
          }),
        ]);
      } catch (error) {
        errors.push(error);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    this.resources.length = 0;
    if (errors.length) throw new AggregateError(errors, "Resource cleanup failed");
  }
}
