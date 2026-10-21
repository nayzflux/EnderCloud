export interface HubRoutingTarget {
  readonly id: string;
  readonly effectiveLoad: number;
  readonly maximumPlayers: number;
}

export interface HubRoutingAssignment {
  readonly targetId: string;
  readonly playerIds: readonly string[];
}

export interface HubRoutingDecision {
  readonly assignments: readonly HubRoutingAssignment[];
  readonly rejectedPlayers: readonly string[];
}

// Allocate one player at a time so a batch converges to the least-loaded
// distribution instead of filling one target before considering the next.
export function allocateHubPlayers(
  playerIds: readonly string[],
  targets: readonly HubRoutingTarget[],
): HubRoutingDecision {
  const mutableTargets = targets.map((target) => ({ ...target }));
  const assignments = new Map<string, string[]>();
  const rejectedPlayers: string[] = [];

  for (const playerId of playerIds) {
    const target = mutableTargets
      .filter((candidate) => candidate.effectiveLoad < candidate.maximumPlayers)
      .sort(
        (left, right) =>
          left.effectiveLoad - right.effectiveLoad ||
          left.id.localeCompare(right.id),
      )[0];
    if (!target) {
      rejectedPlayers.push(playerId);
      continue;
    }
    const assigned = assignments.get(target.id) ?? [];
    assigned.push(playerId);
    assignments.set(target.id, assigned);
    target.effectiveLoad += 1;
  }

  return {
    assignments: [...assignments].map(([targetId, assignedPlayerIds]) => ({
      targetId,
      playerIds: assignedPlayerIds,
    })),
    rejectedPlayers,
  };
}
