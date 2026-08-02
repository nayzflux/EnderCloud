package fr.nayz.endercloud.core.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record PaperEvent(
        String type,
        String endpoint,
        UUID playerId,
        String sessionId,
        List<UUID> playerIds,
        Map<String, Object> results,
        String reason,
        TpsSnapshot tps
) {
    public static PaperEvent serverReady(String endpoint) {
        return new PaperEvent("SERVER_READY", endpoint, null, null, null, null, null, null);
    }

    public static PaperEvent playerJoined(UUID playerId, String sessionId) {
        return new PaperEvent("PLAYER_JOINED", null, playerId, sessionId, null, null, null, null);
    }

    public static PaperEvent playerLeft(UUID playerId, String sessionId) {
        return new PaperEvent("PLAYER_LEFT", null, playerId, sessionId, null, null, null, null);
    }

    public static PaperEvent playerEliminated(UUID playerId, String sessionId) {
        return new PaperEvent(
                "PLAYER_ELIMINATED", null, playerId, sessionId, null, null, null, null
        );
    }

    public static PaperEvent heartbeat(List<UUID> playerIds) {
        return heartbeat(playerIds, null);
    }

    public static PaperEvent heartbeat(List<UUID> playerIds, TpsSnapshot tps) {
        return new PaperEvent(
                "HEARTBEAT", null, null, null, List.copyOf(playerIds), null, null, tps
        );
    }

    public static PaperEvent gameStarting(String sessionId) {
        return new PaperEvent("GAME_STARTING", null, null, sessionId, null, null, null, null);
    }

    public static PaperEvent gameStarted(String sessionId) {
        return new PaperEvent("GAME_STARTED", null, null, sessionId, null, null, null, null);
    }

    public static PaperEvent gameCancelled(String sessionId, String reason) {
        return new PaperEvent(
                "GAME_CANCELLED", null, null, sessionId, null, null, reason, null
        );
    }

    public static PaperEvent gameFinished(String sessionId, Map<String, Object> results) {
        return new PaperEvent(
                "GAME_FINISHED", null, null, sessionId, null, Map.copyOf(results), null, null
        );
    }
}
