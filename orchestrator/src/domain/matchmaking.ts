export type TeamProfile = readonly number[];

export interface ProfileQuality {
  readonly spread: number;
  readonly variance: number;
  readonly emptyTeams: number;
  readonly distanceFromMean: number;
  readonly lexicographic: TeamProfile;
}

export interface SessionPlacementCandidate {
  readonly sessionId: string;
  readonly createdAt: Date;
  readonly ticketSizes: readonly number[];
}

export interface RankedSessionCandidate extends SessionPlacementCandidate {
  readonly profiles: readonly TeamProfile[];
  readonly recommendedProfile: TeamProfile;
  readonly playerCount: number;
  readonly placesRemaining: number;
  readonly complete: boolean;
}

function profileKey(profile: TeamProfile): string {
  return profile.join(",");
}

function compareNumbers(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const comparison = (left[index] ?? 0) - (right[index] ?? 0);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

// Rebuild every anonymous team occupancy that can accommodate all atomic tickets.
export function computeFeasibleProfiles(
  ticketSizes: readonly number[],
  teamCount: number,
  teamSize: number,
): readonly TeamProfile[] {
  if (teamCount < 1 || teamSize < 1) return [];
  let profiles: TeamProfile[] = [Array.from({ length: teamCount }, () => 0)];
  for (const ticketSize of ticketSizes) {
    if (!Number.isInteger(ticketSize) || ticketSize < 1 || ticketSize > teamSize) return [];
    const next = new Map<string, TeamProfile>();
    for (const profile of profiles) {
      for (let team = 0; team < teamCount; team += 1) {
        if (profile[team]! + ticketSize > teamSize) continue;
        const placed = [...profile];
        placed[team] = placed[team]! + ticketSize;
        placed.sort((left, right) => left - right);
        next.set(profileKey(placed), placed);
      }
    }
    profiles = [...next.values()].sort(compareNumbers);
    if (profiles.length === 0) return [];
  }
  return profiles;
}

// Integer-only quality keeps ranking deterministic across Bun, PostgreSQL and Java.
export function profileQuality(profile: TeamProfile): ProfileQuality {
  if (profile.length === 0) {
    return {
      spread: Number.MAX_SAFE_INTEGER,
      variance: Number.MAX_SAFE_INTEGER,
      emptyTeams: Number.MAX_SAFE_INTEGER,
      distanceFromMean: Number.MAX_SAFE_INTEGER,
      lexicographic: profile,
    };
  }
  const total = profile.reduce((sum, value) => sum + value, 0);
  const minimum = profile[0]!;
  const maximum = profile.at(-1)!;
  const scaledDistances = profile.map((value) =>
    Math.abs(value * profile.length - total)
  );
  return {
    spread: maximum - minimum,
    variance: scaledDistances.reduce((sum, value) => sum + value * value, 0),
    emptyTeams: profile.filter((value) => value === 0).length,
    distanceFromMean: scaledDistances.reduce((sum, value) => sum + value, 0),
    lexicographic: profile,
  };
}

export function compareProfileQuality(left: TeamProfile, right: TeamProfile): number {
  const a = profileQuality(left);
  const b = profileQuality(right);
  return (
    a.spread - b.spread ||
    a.variance - b.variance ||
    a.emptyTeams - b.emptyTeams ||
    a.distanceFromMean - b.distanceFromMean ||
    compareNumbers(a.lexicographic, b.lexicographic)
  );
}

export function selectRecommendedProfile(
  profiles: readonly TeamProfile[],
): TeamProfile | null {
  let recommended: TeamProfile | null = null;
  for (const profile of profiles) {
    if (!recommended || compareProfileQuality(profile, recommended) < 0) {
      recommended = profile;
    }
  }
  return recommended;
}

export function isProfileEligible(
  profile: TeamProfile | null,
  minimumPlayersPerTeam: number,
  maximumTeamSpread: number,
): boolean {
  if (!profile || profile.length === 0) return false;
  return (
    profile[0]! >= minimumPlayersPerTeam &&
    profile.at(-1)! - profile[0]! <= maximumTeamSpread
  );
}

export function isSessionLockEligible(
  connectedPlayerCount: number,
  minimumPlayers: number,
  maximumPlayers: number,
  normalDeadlineReached: boolean,
  recommendedProfile: TeamProfile | null,
  minimumPlayersPerTeam: number,
  maximumTeamSpread: number,
): boolean {
  if (!recommendedProfile || connectedPlayerCount < minimumPlayers) return false;
  if (connectedPlayerCount === maximumPlayers) return true;
  return (
    normalDeadlineReached &&
    isProfileEligible(
      recommendedProfile,
      minimumPlayersPerTeam,
      maximumTeamSpread,
    )
  );
}

// Rank all compatible sessions for one FIFO ticket using the public lexicographic policy.
export function rankSessionCandidates(
  sessions: readonly SessionPlacementCandidate[],
  ticketSize: number,
  teamCount: number,
  teamSize: number,
  maximumPlayers = teamCount * teamSize,
): readonly RankedSessionCandidate[] {
  const ranked: RankedSessionCandidate[] = [];
  for (const session of sessions) {
    const ticketSizes = [...session.ticketSizes, ticketSize];
    const playerCount = ticketSizes.reduce((sum, size) => sum + size, 0);
    if (playerCount > maximumPlayers) continue;
    const profiles = computeFeasibleProfiles(ticketSizes, teamCount, teamSize);
    const recommendedProfile = selectRecommendedProfile(profiles);
    if (!recommendedProfile) continue;
    ranked.push({
      ...session,
      profiles,
      recommendedProfile,
      playerCount,
      placesRemaining: maximumPlayers - playerCount,
      complete: playerCount === maximumPlayers,
    });
  }
  return ranked.sort((left, right) =>
    Number(right.complete) - Number(left.complete) ||
    left.placesRemaining - right.placesRemaining ||
    compareProfileQuality(left.recommendedProfile, right.recommendedProfile) ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    right.profiles.length - left.profiles.length ||
    left.sessionId.localeCompare(right.sessionId)
  );
}
