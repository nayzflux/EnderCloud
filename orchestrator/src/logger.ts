export type LogLevel = "debug" | "info" | "warn" | "error";

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  public constructor(private readonly minimum: string = "info") {}

  public debug(message: string, fields: Record<string, unknown> = {}): void {
    this.write("debug", message, fields);
  }

  public info(message: string, fields: Record<string, unknown> = {}): void {
    this.write("info", message, fields);
  }

  public warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", message, fields);
  }

  public error(message: string, fields: Record<string, unknown> = {}): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    const configured = priorities[this.minimum as LogLevel] ?? priorities.info;
    if (priorities[level] < configured) return;
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...fields,
    });
    if (level === "error") console.error(record);
    else if (level === "warn") console.warn(record);
    else console.log(record);
  }
}
