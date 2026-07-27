import type { QueueParty, TeamAssignment } from "./types.ts";

export interface PackResult {
  readonly teams: readonly TeamAssignment[];
  readonly selected: readonly QueueParty[];
  readonly playerCount: number;
}

// Pack whole parties into teams without splitting them or exceeding capacity.
export function packParties(
  parties: readonly QueueParty[],
  teamCount: number,
  teamSize: number,
  maximumPlayers = teamCount * teamSize,
  initialTeams: readonly TeamAssignment[] = [],
): PackResult {
  // Clone the current team occupancy so backfilling can reuse the same packing
  // algorithm without mutating assignments that were already sent to a server.
  const mutable = Array.from({ length: teamCount }, (_, teamIndex) => {
    const existing = initialTeams.find((team) => team.teamIndex === teamIndex);
    return {
      teamIndex,
      parties: [...(existing?.parties ?? [])],
      playerIds: [...(existing?.playerIds ?? [])],
    };
  });
  const selected: QueueParty[] = [];

  // Existing players count toward the global session limit during backfill.
  let playerCount = mutable.reduce((sum, team) => sum + team.playerIds.length, 0);

  // Process the oldest parties first so queue waiting time determines priority.
  for (const party of [...parties].sort(
    (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime(),
  )) {
    // Parties are atomic: an empty or team-sized-invalid party cannot be partially packed.
    if (party.playerIds.length === 0 || party.playerIds.length > teamSize) continue;

    // Keep room checks separate: the session may be full even when one team still has space.
    if (playerCount + party.playerIds.length > maximumPlayers) continue;

    // First-fit chooses the first team with enough contiguous space. This keeps the
    // algorithm deterministic and fills earlier teams before opening later ones.
    const team = mutable.find(
      (candidate) => candidate.playerIds.length + party.playerIds.length <= teamSize,
    );
    if (!team) continue;

    // Update the team, selected queue entries, and aggregate count together so the
    // next party sees the capacity consumed by this assignment.
    team.parties.push(party);
    team.playerIds.push(...party.playerIds);
    selected.push(party);
    playerCount += party.playerIds.length;
  }

  return { teams: mutable, selected, playerCount };
}
