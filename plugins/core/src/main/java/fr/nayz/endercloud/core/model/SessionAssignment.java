package fr.nayz.endercloud.core.model;

import java.util.List;

public record SessionAssignment(
        String sessionId,
        String groupId,
        SessionState state,
        int revision,
        int expectedPlayerCount,
        int connectedPlayerCount,
        boolean acceptingTickets,
        boolean lockEligible,
        List<List<Integer>> feasibleProfiles,
        List<Integer> recommendedProfile,
        List<AssignedPlayer> players
) {
    public SessionAssignment {
        feasibleProfiles = feasibleProfiles.stream().map(List::copyOf).toList();
        recommendedProfile = recommendedProfile == null ? null : List.copyOf(recommendedProfile);
        players = List.copyOf(players);
    }

    public record AssignedPlayer(
            String playerId,
            String partyId,
            String ticketId,
            SessionPlayerState state
    ) {
    }
}
