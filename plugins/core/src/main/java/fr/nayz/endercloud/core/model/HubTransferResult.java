package fr.nayz.endercloud.core.model;

import java.util.List;
import java.util.UUID;

public record HubTransferResult(
        List<UUID> acceptedPlayers,
        List<UUID> rejectedPlayers
) {
    public HubTransferResult {
        acceptedPlayers = List.copyOf(acceptedPlayers);
        rejectedPlayers = List.copyOf(rejectedPlayers);
    }

    public boolean accepted(UUID playerId) {
        return acceptedPlayers.contains(playerId);
    }
}
