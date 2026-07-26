package fr.endercloud.core.http;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import fr.endercloud.core.json.JsonCodec;
import fr.endercloud.core.model.PaperEvent;
import fr.endercloud.core.model.QueueRequest;
import fr.endercloud.core.model.QueueResult;
import fr.endercloud.core.model.ServerSnapshot;
import fr.endercloud.core.model.SessionAssignment;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

public final class EnderCloudClient implements AutoCloseable {
    private final URI baseUri;
    private final HttpClient client;
    private final Duration timeout;

    public EnderCloudClient(URI baseUri) {
        this(baseUri, Duration.ofSeconds(10));
    }

    public EnderCloudClient(URI baseUri, Duration timeout) {
        this.baseUri = baseUri;
        this.timeout = timeout;
        this.client = HttpClient.newBuilder()
                .connectTimeout(timeout)
                .version(HttpClient.Version.HTTP_1_1)
                .build();
    }

    public CompletableFuture<List<ServerSnapshot>> getServers() {
        return send("GET", "/api/v1/proxy/servers", null)
                .thenApply(response -> read(response, new TypeReference<>() {
                }));
    }

    public CompletableFuture<QueueResult> enqueue(QueueRequest request) {
        return send("POST", "/api/v1/queue/entries", JsonCodec.write(request))
                .thenApply(response -> read(response, QueueResult.class));
    }

    public CompletableFuture<Boolean> leaveQueue(String groupId, String partyId) {
        String path = "/api/v1/queue/groups/" + encode(groupId) + "/parties/" + encode(partyId);
        return send("DELETE", path, null).thenApply(response -> {
            JsonNode body = read(response, JsonNode.class);
            return body.path("removed").asBoolean(false);
        });
    }

    public CompletableFuture<Void> networkDisconnected(UUID playerId) {
        return send(
                "POST",
                "/api/v1/proxy/players/" + playerId + "/disconnected",
                null
        ).thenApply(ignored -> null);
    }

    public CompletableFuture<Void> publishEvent(String instanceId, PaperEvent event) {
        return send(
                "POST",
                "/api/v1/instances/" + encode(instanceId) + "/events",
                JsonCodec.write(event)
        ).thenApply(ignored -> null);
    }

    public CompletableFuture<Optional<SessionAssignment>> getAssignment(String instanceId) {
        return sendAllowing404(
                "GET",
                "/api/v1/instances/" + encode(instanceId) + "/assignment",
                null
        ).thenApply(response -> response.statusCode() == 404
                ? Optional.empty()
                : Optional.of(read(response, SessionAssignment.class)));
    }

    public CompletableFuture<Boolean> acknowledgeAssignment(String instanceId, int revision) {
        return send(
                "POST",
                "/api/v1/instances/" + encode(instanceId)
                        + "/assignment/" + revision + "/ack",
                null
        ).thenApply(response -> read(response, JsonNode.class)
                .path("acknowledged").asBoolean(false));
    }

    private CompletableFuture<HttpResponse<String>> send(
            String method,
            String path,
            String body
    ) {
        return sendAllowing404(method, path, body).thenApply(response -> {
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new EnderCloudException(response.statusCode(), response.body());
            }
            return response;
        });
    }

    private CompletableFuture<HttpResponse<String>> sendAllowing404(
            String method,
            String path,
            String body
    ) {
        HttpRequest.BodyPublisher publisher = body == null
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body);
        HttpRequest request = HttpRequest.newBuilder(baseUri.resolve(path))
                .timeout(timeout)
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .method(method, publisher)
                .build();
        return client.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .thenApply(response -> {
                    if (response.statusCode() == 404) return response;
                    if (response.statusCode() < 200 || response.statusCode() >= 300) {
                        throw new EnderCloudException(response.statusCode(), response.body());
                    }
                    return response;
                });
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static <T> T read(HttpResponse<String> response, Class<T> type) {
        try {
            return JsonCodec.mapper().readValue(response.body(), type);
        } catch (IOException exception) {
            throw new EnderCloudException(
                    response.statusCode(),
                    "Invalid orchestrator response: " + exception.getMessage()
            );
        }
    }

    private static <T> T read(HttpResponse<String> response, TypeReference<T> type) {
        try {
            return JsonCodec.mapper().readValue(response.body(), type);
        } catch (IOException exception) {
            throw new EnderCloudException(
                    response.statusCode(),
                    "Invalid orchestrator response: " + exception.getMessage()
            );
        }
    }

    @Override
    public void close() {
        client.close();
    }
}
