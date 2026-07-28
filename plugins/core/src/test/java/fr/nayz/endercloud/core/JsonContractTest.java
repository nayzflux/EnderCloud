package fr.nayz.endercloud.core;

import org.junit.jupiter.api.Test;

import fr.nayz.endercloud.core.model.PaperEvent;
import fr.nayz.endercloud.core.model.QueueRequest;
import fr.nayz.endercloud.core.model.RedisEnvelope;
import fr.nayz.endercloud.core.model.SessionAssignment;
import fr.nayz.endercloud.core.json.JsonCodec;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class JsonContractTest {
    @Test
    void paperEventUsesTheVersionedWireNames() {
        UUID playerId = UUID.fromString("02a1c31e-4748-4106-932d-a780413d7b9a");
        String json = JsonCodec.write(PaperEvent.playerJoined(playerId, "session"));
        assertEquals("PLAYER_JOINED", JsonCodec.readTree(json).path("type").asText());
        assertEquals(playerId.toString(), JsonCodec.readTree(json).path("playerId").asText());

        String cancelled = JsonCodec.write(
                PaperEvent.gameCancelled("session", "not enough teams")
        );
        assertEquals(
                "GAME_CANCELLED",
                JsonCodec.readTree(cancelled).path("type").asText()
        );
        assertEquals(
                "not enough teams",
                JsonCodec.readTree(cancelled).path("reason").asText()
        );
    }

    @Test
    void queueRequestRejectsDuplicatePlayers() {
        UUID playerId = UUID.fromString("02a1c31e-4748-4106-932d-a780413d7b9a");
        assertThrows(
                IllegalArgumentException.class,
                () -> new QueueRequest("group", "party", List.of(playerId, playerId))
        );
    }

    @Test
    void sharedWireFixturesDeserializeInJava() throws IOException {
        Path fixtures = Path.of(System.getProperty("endercloud.contracts.dir"), "fixtures");
        RedisEnvelope transfer = JsonCodec.mapper().readValue(
                Files.readString(fixtures.resolve("transfer-players.json")),
                RedisEnvelope.class
        );
        SessionAssignment assignment = JsonCodec.mapper().readValue(
                Files.readString(fixtures.resolve("assignment.json")),
                SessionAssignment.class
        );
        assertEquals("TRANSFER_PLAYERS", transfer.type());
        assertEquals(2, assignment.revision());
        assertEquals(1, assignment.connectedPlayerCount());
        assertEquals("queue-ticket-1", assignment.players().getFirst().ticketId());
        assertEquals(List.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1), assignment.recommendedProfile());
    }
}
