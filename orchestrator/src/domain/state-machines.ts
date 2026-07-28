import type { AvailabilityState, LifecycleState, SessionState } from "./types.ts";

const lifecycleTransitions: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  CREATING: ["STARTING", "FAILED"],
  STARTING: ["RUNNING", "FAILED", "STOPPING"],
  RUNNING: ["DRAINING", "STOPPING", "FAILED"],
  DRAINING: ["STOPPING", "FAILED"],
  STOPPING: ["STOPPED", "FAILED"],
  STOPPED: [],
  FAILED: ["STOPPING", "STOPPED"],
  ORPHANED: ["STOPPING"],
};

const sessionTransitions: Readonly<Record<SessionState, readonly SessionState[]>> = {
  FORMING: ["WAITING_FOR_INSTANCE", "TRANSFERRING", "CANCELLED"],
  WAITING_FOR_INSTANCE: ["FORMING", "TRANSFERRING", "CANCELLED", "FAILED"],
  TRANSFERRING: ["WAITING", "STARTING", "CANCELLED", "FAILED"],
  WAITING: ["STARTING", "CANCELLED", "FAILED"],
  STARTING: ["RUNNING", "CANCELLED", "FAILED"],
  RUNNING: ["FINISHED", "CANCELLED", "FAILED"],
  FINISHED: [],
  CANCELLED: [],
  FAILED: [],
};

export function assertLifecycleTransition(from: LifecycleState, to: LifecycleState): void {
  if (!lifecycleTransitions[from].includes(to)) {
    throw new Error(`Invalid lifecycle transition ${from} -> ${to}`);
  }
}

export function assertSessionTransition(from: SessionState, to: SessionState): void {
  if (!sessionTransitions[from].includes(to)) {
    throw new Error(`Invalid session transition ${from} -> ${to}`);
  }
}

export function assertAvailabilityTransition(
  from: AvailabilityState,
  to: AvailabilityState,
): void {
  if (from === to) return;
  if (from !== "OPEN" || to !== "RESERVED") {
    throw new Error(`Invalid availability transition ${from} -> ${to}`);
  }
}

export function isWarmReady(
  lifecycle: LifecycleState,
  availability: AvailabilityState,
): boolean {
  return lifecycle === "RUNNING" && availability === "OPEN";
}

export function isWarmPending(
  lifecycle: LifecycleState,
  availability: AvailabilityState,
): boolean {
  return (lifecycle === "CREATING" || lifecycle === "STARTING") && availability === "OPEN";
}

export function isTerminalLifecycle(state: LifecycleState): boolean {
  return state === "STOPPED" || state === "FAILED";
}
