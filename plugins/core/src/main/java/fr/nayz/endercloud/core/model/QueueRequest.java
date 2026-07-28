package fr.nayz.endercloud.core.model;

import java.util.List;
import java.util.Objects;
import java.util.UUID;

public record QueueRequest(String groupId, String partyId, List<UUID> players) {
    public QueueRequest {
        Objects.requireNonNull(groupId, "groupId");
        Objects.requireNonNull(partyId, "partyId");
        players = List.copyOf(players);
        if (players.isEmpty()) {
            throw new IllegalArgumentException("A party must contain at least one player");
        }
        if (players.stream().distinct().count() != players.size()) {
            throw new IllegalArgumentException("A party cannot contain duplicate players");
        }
    }
}
