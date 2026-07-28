package fr.nayz.endercloud.core.api;

import java.util.UUID;
import java.util.concurrent.CompletableFuture;

public interface EnderCloudVelocityApi {
    CompletableFuture<Boolean> sendToHub(UUID playerId);
}
