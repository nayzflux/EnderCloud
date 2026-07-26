package fr.endercloud.core.api;

import fr.endercloud.core.model.QueueRequest;
import fr.endercloud.core.model.QueueResult;
import fr.endercloud.core.model.SessionAssignment;

import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

public interface EnderCloudPaperApi {
    CompletableFuture<QueueResult> enqueue(QueueRequest request);

    CompletableFuture<Boolean> leaveQueue(String groupId, String partyId);

    Optional<SessionAssignment> currentAssignment();

    CompletableFuture<Void> reportGameStarting(String sessionId);

    CompletableFuture<Void> reportGameStarted(String sessionId);

    CompletableFuture<Void> reportGameFinished(String sessionId, Map<String, Object> results);
}
