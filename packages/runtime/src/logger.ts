import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;

export interface LoggerOptions {
  readonly service?: string;
  readonly version?: string;
  readonly component?: string;
  readonly context?: LogFields;
  readonly sink?: (level: LogLevel, record: string) => void;
}

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const reservedFields = new Set([
  "timestamp", "level", "service", "version", "event", "message", "component",
]);
const secretPattern = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|environment)/i;
const urlPattern = /\b(?:postgres(?:ql)?|redis|https?):\/\/[^\s]+/gi;
const contextStorage = new AsyncLocalStorage<LogFields>();
const maximumDepth = 5;
const maximumStringLength = 8_192;
const maximumCollectionLength = 100;
const sensitiveEnvironmentValues = Object.entries(process.env)
  .filter(([key, value]) => secretPattern.test(key) && (value?.length ?? 0) >= 4)
  .map(([, value]) => value!);

function eventName(message: string): string {
  return message.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "") || "log";
}

function sanitizeUrl(value: string): string {
  const withoutCredentials = value.replace(urlPattern, (candidate) => {
    try {
      const parsed = new URL(candidate);
      if (parsed.username) parsed.username = "[redacted]";
      if (parsed.password) parsed.password = "[redacted]";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return candidate;
    }
  });
  return sensitiveEnvironmentValues.reduce(
    (clean, secret) => clean.replaceAll(secret, "[redacted]"),
    withoutCredentials,
  );
}

function sanitizeError(error: Error, depth: number): LogFields {
  const candidate = error as Error & { code?: unknown; cause?: unknown };
  return {
    name: error.name,
    message: sanitizeUrl(error.message).slice(0, maximumStringLength),
    ...(candidate.code !== undefined ? { code: sanitize(candidate.code, depth + 1) } : {}),
    ...(error.stack ? { stack: sanitizeUrl(error.stack).slice(0, maximumStringLength) } : {}),
    ...(candidate.cause !== undefined && depth < maximumDepth
      ? { cause: sanitize(candidate.cause, depth + 1) }
      : {}),
  };
}

function sanitize(value: unknown, depth = 0, key = ""): unknown {
  if (secretPattern.test(key)) return "[redacted]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return sanitizeUrl(value).slice(0, maximumStringLength);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return sanitizeError(value, depth);
  if (depth >= maximumDepth) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, maximumCollectionLength).map((entry) => sanitize(entry, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value).slice(0, maximumCollectionLength)) {
      output[entryKey] = sanitize(entryValue, depth + 1, entryKey);
    }
    return output;
  }
  return String(value).slice(0, maximumStringLength);
}

function cleanFields(fields: LogFields): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!reservedFields.has(key)) output[key] = sanitize(value, 0, key);
  }
  return output;
}

function defaultSink(level: LogLevel, record: string): void {
  if (level === "error") console.error(record);
  else if (level === "warn") console.warn(record);
  else console.log(record);
}

export class Logger {
  private readonly service: string;
  private readonly version: string;
  private readonly component: string | undefined;
  private readonly context: LogFields;
  private readonly sink: (level: LogLevel, record: string) => void;

  public constructor(
    private readonly minimum: LogLevel = "info",
    options: LoggerOptions = {},
  ) {
    this.service = options.service ?? "endercloud";
    this.version = options.version ?? "unknown";
    this.component = options.component;
    this.context = options.context ?? {};
    this.sink = options.sink ?? defaultSink;
  }

  public child(context: LogFields & { readonly component?: string }): Logger {
    const { component, ...fields } = context;
    const childComponent = component ?? this.component;
    return new Logger(this.minimum, {
      service: this.service,
      version: this.version,
      ...(childComponent ? { component: childComponent } : {}),
      context: { ...this.context, ...fields },
      sink: this.sink,
    });
  }

  public runWithContext<T>(context: LogFields, operation: () => T): T {
    return contextStorage.run({ ...(contextStorage.getStore() ?? {}), ...context }, operation);
  }

  public enterContext(context: LogFields): void {
    contextStorage.enterWith(context);
  }

  public currentContext(): LogFields {
    return { ...this.context, ...(contextStorage.getStore() ?? {}) };
  }

  public debug(event: string, messageOrFields: string | LogFields = {}, fields: LogFields = {}): void {
    this.write("debug", event, messageOrFields, fields);
  }

  public info(event: string, messageOrFields: string | LogFields = {}, fields: LogFields = {}): void {
    this.write("info", event, messageOrFields, fields);
  }

  public warn(event: string, messageOrFields: string | LogFields = {}, fields: LogFields = {}): void {
    this.write("warn", event, messageOrFields, fields);
  }

  public error(event: string, messageOrFields: string | LogFields = {}, fields: LogFields = {}): void {
    this.write("error", event, messageOrFields, fields);
  }

  private write(level: LogLevel, eventOrMessage: string, messageOrFields: string | LogFields, fields: LogFields): void {
    if (priorities[level] < priorities[this.minimum]) return;
    const explicitMessage = typeof messageOrFields === "string";
    const message = explicitMessage ? messageOrFields : eventOrMessage;
    const event = explicitMessage ? eventOrMessage : eventName(eventOrMessage);
    const supplied = explicitMessage ? fields : messageOrFields;
    this.sink(level, JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      version: this.version,
      event,
      message,
      ...(this.component ? { component: this.component } : {}),
      ...cleanFields(this.context),
      ...cleanFields(contextStorage.getStore() ?? {}),
      ...cleanFields(supplied),
    }));
  }
}
