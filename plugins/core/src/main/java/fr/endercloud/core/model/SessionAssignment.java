package fr.endercloud.core.model;

import java.util.List;

public record SessionAssignment(
        String sessionId,
        String groupId,
        SessionState state,
        int revision,
        List<AssignedPlayer> players
) {
    public SessionAssignment {
        players = List.copyOf(players);
    }

    public record AssignedPlayer(
            String playerId,
            String partyId,
            int teamIndex,
            SessionPlayerState state
    ) {
    }
}
