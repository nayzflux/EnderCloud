package fr.nayz.endercloud.core.api;

import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

import fr.nayz.endercloud.core.model.QueueRequest;
import fr.nayz.endercloud.core.model.QueueResult;
import fr.nayz.endercloud.core.model.SessionAssignment;

public interface EnderCloudPaperApi {
    CompletableFuture<QueueResult> enqueue(QueueRequest request);

    CompletableFuture<Boolean> leaveQueue(String groupId, String partyId);

    Optional<SessionAssignment> currentAssignment();

    CompletableFuture<Void> reportGameStarting(String sessionId);

    CompletableFuture<Void> reportGameStarted(String sessionId);

    CompletableFuture<Void> reportGameCancelled(String sessionId, String reason);

    CompletableFuture<Void> reportGameFinished(String sessionId, Map<String, Object> results);
}
