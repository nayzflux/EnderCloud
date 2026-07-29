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

// Compute how many instances to create or drain from the current pool state.
export function decideCapacity(
  policy: CapacityPolicy,
  instances: readonly InstanceCapacityState[],
  enabled = true,
  requiredActiveInstances = 0,
): CapacityDecision {
  // Terminal instances consume no capacity and must not affect scaling decisions.
  const activeInstances = instances.filter(
    ({ lifecycle }) => lifecycle !== "STOPPED" && lifecycle !== "FAILED",
  );
  // Separate usable capacity from capacity still booting to avoid over-creation.
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

  // Two independent deficits are considered: total resilience and immediately usable warm capacity.
  const desiredForMinimumInstances = Math.max(0, policy.minimumInstances - active);
  const desiredForPlayerDemand = Math.max(0, requiredActiveInstances - active);
  const desiredForWarm = Math.max(
    0,
    policy.minimumWarmInstances - warmReady - warmPending,
  );
  const room = Math.max(0, policy.maximumInstances - active);
  // Create enough for the larger deficit, but never cross the absolute maximum.
  const create = Math.min(
    room,
    Math.max(
      desiredForMinimumInstances,
      desiredForPlayerDemand,
      desiredForWarm,
    ),
  );
  // Drain only the overlap between excess warm capacity and instances above the minimum floor.
  const activeFloor = Math.max(policy.minimumInstances, requiredActiveInstances);
  const drain = Math.max(
    0,
    Math.min(
      warmReady - policy.maximumWarmInstances,
      active - activeFloor,
    ),
  );

  return { warmReady, warmPending, active, create, drain };
}
