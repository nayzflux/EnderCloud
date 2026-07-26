import type { AvailabilityState, CapacityPolicy, LifecycleState } from "./types.ts";
import { isWarmPending, isWarmReady } from "./state-machines.ts";

export interface InstanceCapacityState {
  readonly lifecycle: LifecycleState;
  readonly availability: AvailabilityState;
}

export interface CapacityDecision {
  readonly warmReady: number;
  readonly warmPending: number;
  readonly active: number;
  readonly create: number;
  readonly drain: number;
}

export function decideCapacity(
  policy: CapacityPolicy,
  instances: readonly InstanceCapacityState[],
  enabled = true,
): CapacityDecision {
  const activeInstances = instances.filter(
    ({ lifecycle }) => lifecycle !== "STOPPED" && lifecycle !== "FAILED",
  );
  const warmReady = activeInstances.filter(({ lifecycle, availability }) =>
    isWarmReady(lifecycle, availability),
  ).length;
  const warmPending = activeInstances.filter(({ lifecycle, availability }) =>
    isWarmPending(lifecycle, availability),
  ).length;
  const active = activeInstances.length;

  if (!enabled) {
    return { warmReady, warmPending, active, create: 0, drain: warmReady };
  }

  const desiredForMinimumInstances = Math.max(0, policy.minimumInstances - active);
  const desiredForWarm = Math.max(
    0,
    policy.minimumWarmInstances - warmReady - warmPending,
  );
  const room = Math.max(0, policy.maximumInstances - active);
  const create = Math.min(room, Math.max(desiredForMinimumInstances, desiredForWarm));
  const drain = Math.max(
    0,
    Math.min(
      warmReady - policy.maximumWarmInstances,
      active - policy.minimumInstances,
    ),
  );

  return { warmReady, warmPending, active, create, drain };
}
