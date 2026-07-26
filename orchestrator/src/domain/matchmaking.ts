import type { QueueParty, TeamAssignment } from "./types.ts";

export interface PackResult {
  readonly teams: readonly TeamAssignment[];
  readonly selected: readonly QueueParty[];
  readonly playerCount: number;
}

export function packParties(
  parties: readonly QueueParty[],
  teamCount: number,
  teamSize: number,
  maximumPlayers = teamCount * teamSize,
  initialTeams: readonly TeamAssignment[] = [],
): PackResult {
  const mutable = Array.from({ length: teamCount }, (_, teamIndex) => {
    const existing = initialTeams.find((team) => team.teamIndex === teamIndex);
    return {
      teamIndex,
      parties: [...(existing?.parties ?? [])],
      playerIds: [...(existing?.playerIds ?? [])],
    };
  });
  const selected: QueueParty[] = [];
  let playerCount = mutable.reduce((sum, team) => sum + team.playerIds.length, 0);

  for (const party of [...parties].sort(
    (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime(),
  )) {
    if (party.playerIds.length === 0 || party.playerIds.length > teamSize) continue;
    if (playerCount + party.playerIds.length > maximumPlayers) continue;
    const team = mutable.find(
      (candidate) => candidate.playerIds.length + party.playerIds.length <= teamSize,
    );
    if (!team) continue;
    team.parties.push(party);
    team.playerIds.push(...party.playerIds);
    selected.push(party);
    playerCount += party.playerIds.length;
  }

  return { teams: mutable, selected, playerCount };
}
