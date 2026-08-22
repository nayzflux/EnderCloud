export interface StartupFailureDecision {
  readonly state: "BACKING_OFF" | "BLOCKED";
  readonly delayMs: number | null;
}

export function decideStartupFailure(
  failureCount: number,
  retryLimit: number,
  baseDelayMs: number,
): StartupFailureDecision {
  if (!Number.isInteger(failureCount) || failureCount < 1) {
    throw new Error("failureCount must be a positive integer");
  }
  if (!Number.isInteger(retryLimit) || retryLimit < 0) {
    throw new Error("retryLimit must be a non-negative integer");
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) {
    throw new Error("baseDelayMs must be positive");
  }
  if (failureCount > retryLimit) return { state: "BLOCKED", delayMs: null };
  return {
    state: "BACKING_OFF",
    delayMs: baseDelayMs * 2 ** (failureCount - 1),
  };
}

export function countsAsStartupFailure(reason: string, becameReady: boolean): boolean {
  return !becameReady && (
    reason === "CREATE_FAILED" ||
    reason === "STARTUP_TIMEOUT" ||
    reason === "RUNTIME_MISSING"
  );
}
