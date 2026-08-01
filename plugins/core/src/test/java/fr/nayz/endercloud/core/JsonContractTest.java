package fr.nayz.endercloud.core;

import org.junit.jupiter.api.Test;

import fr.nayz.endercloud.core.model.PaperEvent;
import fr.nayz.endercloud.core.model.QueueRequest;
import fr.nayz.endercloud.core.model.RedisEnvelope;
import fr.nayz.endercloud.core.model.SessionAssignment;
import fr.nayz.endercloud.core.model.HubTransferResult;
import fr.nayz.endercloud.core.model.ServerSnapshot;
import fr.nayz.endercloud.core.model.LifecycleState;
import fr.nayz.endercloud.core.model.AvailabilityState;
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

        String eliminated = JsonCodec.write(PaperEvent.playerEliminated(playerId, "session"));
        assertEquals(
                "PLAYER_ELIMINATED",
                JsonCodec.readTree(eliminated).path("type").asText()
        );
        assertEquals(
                "session",
                JsonCodec.readTree(eliminated).path("sessionId").asText()
        );
        assertEquals(
                playerId.toString(),
                JsonCodec.readTree(eliminated).path("playerId").asText()
        );

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

    @Test
    void hubRoutingKeepsTheTargetSoftAndTheMaximumHard() {
        ServerSnapshot aboveTarget = new ServerSnapshot(
                "instance",
                "variant",
                "hub",
                "hub",
                "hub:25565",
                LifecycleState.RUNNING,
                AvailabilityState.OPEN,
                75,
                100
        );
        ServerSnapshot full = new ServerSnapshot(
                "instance",
                "variant",
                "hub",
                "hub",
                "hub:25565",
                LifecycleState.RUNNING,
                AvailabilityState.OPEN,
                100,
                100
        );
        assertEquals(true, aboveTarget.isHubTarget());
        assertEquals(false, full.isHubTarget());
    }

    @Test
    void hubTransferResultUsesUuidLists() {
        UUID playerId = UUID.fromString("02a1c31e-4748-4106-932d-a780413d7b9a");
        HubTransferResult result = JsonCodec.mapper().convertValue(
                JsonCodec.readTree(
                        "{\"acceptedPlayers\":[\"" + playerId
                                + "\"],\"rejectedPlayers\":[]}"
                ),
                HubTransferResult.class
        );
        assertEquals(List.of(playerId), result.acceptedPlayers());
        assertEquals(true, result.accepted(playerId));
    }
}
