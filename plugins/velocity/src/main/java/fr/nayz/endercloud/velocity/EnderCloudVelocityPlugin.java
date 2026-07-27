package fr.nayz.endercloud.velocity;

import com.fasterxml.jackson.databind.JsonNode;
import com.google.inject.Inject;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.connection.DisconnectEvent;
import com.velocitypowered.api.event.player.KickedFromServerEvent;
import com.velocitypowered.api.event.player.PlayerChooseInitialServerEvent;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.event.proxy.ProxyShutdownEvent;
import com.velocitypowered.api.plugin.Plugin;
import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.proxy.server.RegisteredServer;
import com.velocitypowered.api.proxy.server.ServerInfo;
import fr.endercloud.core.api.EnderCloudVelocityApi;
import fr.endercloud.core.http.EnderCloudClient;
import fr.endercloud.core.json.JsonCodec;
import fr.endercloud.core.model.RedisEnvelope;
import fr.endercloud.core.model.ServerSnapshot;
import io.lettuce.core.RedisChannelHandler;
import io.lettuce.core.RedisClient;
import io.lettuce.core.RedisConnectionStateListener;
import io.lettuce.core.pubsub.RedisPubSubAdapter;
import io.lettuce.core.pubsub.StatefulRedisPubSubConnection;
import org.slf4j.Logger;

import java.net.InetSocketAddress;
import java.net.URI;
import java.util.Comparator;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

@Plugin(
        id = "endercloud",
        name = "EnderCloud",
        version = "0.1.0",
        description = "Velocity bridge for the EnderCloud orchestrator"
)
public final class EnderCloudVelocityPlugin implements EnderCloudVelocityApi {

    private static final String REGISTRY_CHANNEL = "minecraft:proxy:registry";
    private static final String TRANSFER_CHANNEL = "minecraft:proxy:transfers";

    private final ProxyServer proxy;
    private final Logger logger;
    private final Map<String, ServerSnapshot> snapshots = new ConcurrentHashMap<>();
    private final Set<String> transfersInFlight = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean ready = new AtomicBoolean();

    private EnderCloudClient orchestrator;
    private RedisClient redis;
    private StatefulRedisPubSubConnection<String, String> subscription;

    @Inject
    public EnderCloudVelocityPlugin(ProxyServer proxy, Logger logger) {
        this.proxy = proxy;
        this.logger = logger;
    }

    @Subscribe
    public void onInitialize(ProxyInitializeEvent ignored) {
        URI orchestratorUrl = URI.create(
                environment("ENDERCLOUD_ORCHESTRATOR_URL", "http://localhost:8080")
        );
        String redisUrl = environment("ENDERCLOUD_REDIS_URL", "redis://localhost:6379");
        orchestrator = new EnderCloudClient(orchestratorUrl);
        redis = RedisClient.create(redisUrl);
        subscription = redis.connectPubSub();
        subscription.addListener(new RedisPubSubAdapter<>() {
            @Override
            public void message(String channel, String message) {
                handleRedisMessage(channel, message);
            }
        });
        subscription.addListener(new RedisConnectionStateListener() {
            @Override
            public void onRedisConnected(RedisChannelHandler<?, ?> connection) {
                synchronizeRegistry();
            }

            @Override
            public void onRedisDisconnected(RedisChannelHandler<?, ?> connection) {
                ready.set(false);
                logger.warn("EnderCloud Redis subscription disconnected");
            }
        });
        synchronizeRegistry();
    }

    @Subscribe
    public void onShutdown(ProxyShutdownEvent ignored) {
        ready.set(false);
        if (subscription != null) subscription.close();
        if (redis != null) redis.shutdown();
        if (orchestrator != null) orchestrator.close();
    }

    @Subscribe
    public void onInitialServer(PlayerChooseInitialServerEvent event) {
        selectHub().ifPresent(event::setInitialServer);
    }

    @Subscribe
    public void onKicked(KickedFromServerEvent event) {
        selectHub()
                .filter(server -> !server.equals(event.getServer()))
                .ifPresent(server -> event.setResult(
                        KickedFromServerEvent.RedirectPlayer.create(server)
                ));
    }

    @Subscribe
    public void onDisconnect(DisconnectEvent event) {
        if (orchestrator == null) return;
        orchestrator.networkDisconnected(event.getPlayer().getUniqueId())
                .exceptionally(error -> {
                    logger.warn(
                            "Unable to report disconnect for {}",
                            event.getPlayer().getUniqueId(),
                            error
                    );
                    return null;
                });
    }

    @Override
    public CompletableFuture<Boolean> sendToHub(UUID playerId) {
        Optional<RegisteredServer> hub = selectHub();
        return proxy.getPlayer(playerId)
                .map(player -> hub
                        .map(server -> player.createConnectionRequest(server)
                                .connect()
                                .thenApply(result -> result.isSuccessful()))
                        .orElseGet(() -> CompletableFuture.completedFuture(false)))
                .orElseGet(() -> CompletableFuture.completedFuture(false));
    }

    public boolean isReady() {
        return ready.get();
    }

    private void synchronizeRegistry() {
        if (subscription == null || !subscription.isOpen()) return;
        subscription.async()
                .subscribe(REGISTRY_CHANNEL, TRANSFER_CHANNEL)
                .thenCompose(ignored -> reloadSnapshot())
                .whenComplete((ignored, error) -> {
                    if (error != null) {
                        ready.set(false);
                        logger.error("Unable to synchronize the EnderCloud registry", error);
                    } else {
                        ready.set(true);
                        logger.info("EnderCloud Velocity registry synchronized");
                    }
                });
    }

    private CompletableFuture<Void> reloadSnapshot() {
        return orchestrator.getServers().thenAccept(servers -> {
            snapshots.clear();
            servers.forEach(server -> snapshots.put(server.instanceId(), server));
            for (RegisteredServer registered : proxy.getAllServers()) {
                String name = registered.getServerInfo().getName();
                if (name.startsWith("ec-") || name.startsWith("endercloud-")) {
                    proxy.unregisterServer(registered.getServerInfo());
                }
            }
            servers.forEach(this::register);
        });
    }

    private void handleRedisMessage(String channel, String message) {
        try {
            RedisEnvelope envelope = JsonCodec.mapper().readValue(
                    message,
                    RedisEnvelope.class
            );
            if (envelope.schemaVersion() != 1) {
                logger.warn(
                        "Ignoring unsupported EnderCloud event schema {}",
                        envelope.schemaVersion()
                );
                return;
            }
            switch (envelope.type()) {
                case "SERVER_REGISTERED" -> {
                    ServerSnapshot snapshot = JsonCodec.mapper().treeToValue(
                            envelope.payload(),
                            ServerSnapshot.class
                    );
                    snapshots.put(snapshot.instanceId(), snapshot);
                    register(snapshot);
                }
                case "SERVER_UNREGISTERED" -> unregister(
                        envelope.payload().path("instanceId").asText()
                );
                case "TRANSFER_PLAYERS" -> transferPlayers(envelope.payload(), true);
                default -> logger.debug(
                        "Ignoring unknown EnderCloud event {}",
                        envelope.type()
                );
            }
        } catch (Exception exception) {
            logger.error("Invalid EnderCloud Redis message on {}", channel, exception);
            reloadSnapshot().exceptionally(error -> {
                logger.error("Snapshot reload after an invalid event failed", error);
                return null;
            });
        }
    }

    private void register(ServerSnapshot snapshot) {
        if (snapshot.endpoint() == null || snapshot.endpoint().isBlank()) return;
        String name = serverName(snapshot);
        proxy.getServer(name)
                .ifPresent(server -> proxy.unregisterServer(server.getServerInfo()));
        proxy.registerServer(new ServerInfo(name, parseEndpoint(snapshot.endpoint())));
    }

    private void unregister(String instanceId) {
        ServerSnapshot snapshot = snapshots.remove(instanceId);
        if (snapshot == null) return;
        proxy.getServer(serverName(snapshot))
                .ifPresent(server -> proxy.unregisterServer(server.getServerInfo()));
    }

    private void transferPlayers(JsonNode payload, boolean reloadAllowed) {
        String instanceId = payload.path("instanceId").asText();
        ServerSnapshot snapshot = snapshots.get(instanceId);
        Optional<RegisteredServer> target = snapshot == null
                ? Optional.empty()
                : proxy.getServer(serverName(snapshot));
        if (target.isEmpty()) {
            if (reloadAllowed) {
                reloadSnapshot()
                        .thenRun(() -> transferPlayers(payload, false))
                        .exceptionally(error -> {
                            logger.error("Unable to reload registry for transfer", error);
                            return null;
                        });
            }
            return;
        }
        for (JsonNode playerNode : payload.path("players")) {
            try {
                UUID playerId = UUID.fromString(playerNode.asText());
                proxy.getPlayer(playerId).ifPresent(player -> {
                    boolean alreadyConnected = player.getCurrentServer()
                            .map(connection -> connection.getServer().equals(target.orElseThrow()))
                            .orElse(false);
                    if (alreadyConnected) return;
                    String commandId = payload.path("commandId").asText(instanceId);
                    String inFlightKey = commandId + ":" + playerId;
                    if (!transfersInFlight.add(inFlightKey)) return;
                    player.createConnectionRequest(target.orElseThrow())
                            .connect()
                            .whenComplete((result, error) ->
                                    transfersInFlight.remove(inFlightKey)
                            );
                });
            } catch (IllegalArgumentException exception) {
                logger.warn(
                        "Ignoring invalid player UUID in transfer: {}",
                        playerNode.asText()
                );
            }
        }
    }

    private Optional<RegisteredServer> selectHub() {
        return snapshots.values().stream()
                .filter(ServerSnapshot::isHubTarget)
                .sorted(Comparator.comparingInt(ServerSnapshot::playerCount)
                        .thenComparing(ServerSnapshot::instanceId))
                .map(snapshot -> proxy.getServer(serverName(snapshot)))
                .flatMap(Optional::stream)
                .findFirst();
    }

    static InetSocketAddress parseEndpoint(String endpoint) {
        int separator = endpoint.lastIndexOf(':');
        if (separator <= 0 || separator == endpoint.length() - 1) {
            throw new IllegalArgumentException("Invalid Minecraft endpoint: " + endpoint);
        }
        return InetSocketAddress.createUnresolved(
                endpoint.substring(0, separator),
                Integer.parseInt(endpoint.substring(separator + 1))
        );
    }

    private static String serverName(ServerSnapshot snapshot) {
        return "ec-" + snapshot.variantId() + "-" + snapshot.instanceId();
    }

    private static String environment(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }
}
