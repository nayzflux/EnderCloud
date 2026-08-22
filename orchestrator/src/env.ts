import type { LogLevel } from "./logger.ts";

const durationPattern = /^(\d+)(ms|s|m|h|d)$/;
const durationFactors = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

export type Environment = Readonly<Record<string, string | undefined>>;

export function rejectDeprecatedEnvironment(
  environment: Environment,
  replacements: Readonly<Record<string, string>>,
): void {
  for (const [name, replacement] of Object.entries(replacements)) {
    if (environment[name] !== undefined) {
      throw new Error(`${name} was removed; use ${replacement}`);
    }
  }
}

export function optionalString(
  environment: Environment,
  name: string,
  fallback: string,
): string {
  const value = environment[name]?.trim();
  return value ? value : fallback;
}

export function requiredString(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function integer(
  environment: Environment,
  name: string,
  fallback?: number,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = environment[name];
  if (raw === undefined && fallback === undefined) throw new Error(`${name} is required`);
  if (!/^\d+$/.test(raw ?? String(fallback))) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function positiveNumber(environment: Environment, name: string): number {
  const value = Number(requiredString(environment, name));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

export function duration(
  environment: Environment,
  name: string,
  fallback: string,
  minimumMs = 1,
): number {
  const raw = optionalString(environment, name, fallback);
  const match = durationPattern.exec(raw);
  if (!match) throw new Error(`${name} must be a duration such as 500ms, 5s or 10m`);
  const amount = Number(match[1]);
  const value = amount * durationFactors[match[2] as keyof typeof durationFactors];
  if (!Number.isSafeInteger(value) || value < minimumMs) {
    throw new Error(`${name} must be at least ${minimumMs}ms`);
  }
  return value;
}

export function url(
  environment: Environment,
  name: string,
  fallback?: string,
  protocols?: readonly string[],
): string {
  const value = fallback === undefined
    ? requiredString(environment, name)
    : optionalString(environment, name, fallback);
  try {
    const parsed = new URL(value);
    if (protocols && !protocols.includes(parsed.protocol)) {
      throw new Error("invalid protocol");
    }
    return parsed.toString();
  } catch {
    throw new Error(`${name} must be a valid ${protocols?.join(" or ") ?? "URL"}`);
  }
}

export function logLevel(
  environment: Environment,
  name: string,
  fallback: LogLevel = "info",
): LogLevel {
  const value = optionalString(environment, name, fallback);
  if (value !== "debug" && value !== "info" && value !== "warn" && value !== "error") {
    throw new Error(`${name} must be one of debug, info, warn or error`);
  }
  return value;
}
