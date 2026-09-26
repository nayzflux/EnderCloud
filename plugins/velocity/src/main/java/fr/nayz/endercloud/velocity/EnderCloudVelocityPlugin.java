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
import com.velocitypowered.api.scheduler.ScheduledTask;

import fr.nayz.endercloud.core.api.EnderCloudVelocityApi;
import fr.nayz.endercloud.core.json.JsonCodec;
import fr.nayz.endercloud.core.model.RedisEnvelope;
import fr.nayz.endercloud.core.model.ServerSnapshot;
import fr.nayz.endercloud.core.http.EnderCloudClient;
import io.lettuce.core.RedisChannelHandler;
import io.lettuce.core.RedisClient;
import io.lettuce.core.RedisConnectionStateListener;
import io.lettuce.core.pubsub.RedisPubSubAdapter;
import io.lettuce.core.pubsub.StatefulRedisPubSubConnection;
import org.slf4j.Logger;

import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.net.URI;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
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
    private final AtomicBoolean synchronizationInProgress = new AtomicBoolean();

    private EnderCloudClient orchestrator;
    private RedisClient redis;
    private StatefulRedisPubSubConnection<String, String> subscription;
    private ScheduledTask refreshTask;
    private volatile boolean shuttingDown;

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
        refreshTask = proxy.getScheduler().buildTask(this, this::refreshRegistry)
                .delay(30, TimeUnit.SECONDS)
                .repeat(30, TimeUnit.SECONDS)
                .schedule();
    }

    @Subscribe
    public void onShutdown(ProxyShutdownEvent ignored) {
        shuttingDown = true;
        ready.set(false);
        if (refreshTask != null) refreshTask.cancel();
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
        selectHub(event.getServer())
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
        return proxy.getPlayer(playerId)
                .flatMap(player -> player.getCurrentServer()
                        .flatMap(connection -> instanceId(connection.getServer())))
                .map(instanceId -> orchestrator.sendToHub(instanceId, Set.of(playerId))
                        .thenApply(result -> result.accepted(playerId)))
                .orElseGet(() -> CompletableFuture.completedFuture(false));
    }

    public boolean isReady() {
        return ready.get();
    }

    private void synchronizeRegistry() {
        if (shuttingDown || subscription == null || !subscription.isOpen()) return;
        if (!synchronizationInProgress.compareAndSet(false, true)) return;
        subscription.async()
                .subscribe(REGISTRY_CHANNEL, TRANSFER_CHANNEL)
                .thenCompose(ignored -> reloadSnapshot())
                .whenComplete((ignored, error) -> {
                    synchronizationInProgress.set(false);
                    if (shuttingDown) return;
                    if (error != null) {
                        ready.set(false);
                        logger.error("Unable to synchronize the EnderCloud registry", error);
                    } else {
                        ready.set(true);
                        logger.info("EnderCloud Velocity registry synchronized");
                    }
                });
    }

    private void refreshRegistry() {
        if (shuttingDown) return;
        if (!ready.get()) {
            synchronizeRegistry();
            return;
        }
        if (!synchronizationInProgress.compareAndSet(false, true)) return;
        reloadSnapshot().whenComplete((ignored, error) -> {
            synchronizationInProgress.set(false);
            if (shuttingDown) return;
            if (error != null) {
                ready.set(false);
                logger.error("Unable to refresh the EnderCloud registry", error);
            }
        });
    }

    private CompletableFuture<Void> reloadSnapshot() {
        return orchestrator.getServers().thenAccept(servers -> {
            Map<String, SocketAddress> registeredAddresses = new HashMap<>();
            for (RegisteredServer registered : proxy.getAllServers()) {
                ServerInfo info = registered.getServerInfo();
                registeredAddresses.put(info.getName(), info.getAddress());
            }
            RegistryReconciliation.Changes changes = RegistryReconciliation.plan(
                    servers,
                    registeredAddresses
            );
            for (String name : changes.unregister()) {
                proxy.getServer(name)
                        .ifPresent(server -> proxy.unregisterServer(server.getServerInfo()));
            }
            for (ServerSnapshot server : changes.register()) {
                proxy.registerServer(new ServerInfo(
                        serverName(server),
                        parseEndpoint(server.endpoint())
                ));
            }
            snapshots.clear();
            servers.forEach(server -> snapshots.put(server.instanceId(), server));
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
                    update(snapshot);
                }
                case "SERVER_UPDATED" -> {
                    ServerSnapshot snapshot = JsonCodec.mapper().treeToValue(
                            envelope.payload(),
                            ServerSnapshot.class
                    );
                    update(snapshot);
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
        String name = serverName(snapshot);
        Optional<RegisteredServer> existing = proxy.getServer(name);
        if (snapshot.endpoint() == null || snapshot.endpoint().isBlank()) {
            existing.ifPresent(server -> proxy.unregisterServer(server.getServerInfo()));
            return;
        }
        InetSocketAddress endpoint = parseEndpoint(snapshot.endpoint());
        if (existing.isPresent() && Objects.equals(
                existing.get().getServerInfo().getAddress(), endpoint
        )) {
            return;
        }
        existing.ifPresent(server -> proxy.unregisterServer(server.getServerInfo()));
        proxy.registerServer(new ServerInfo(name, endpoint));
    }

    private void unregister(String instanceId) {
        ServerSnapshot snapshot = snapshots.remove(instanceId);
        if (snapshot == null) return;
        proxy.getServer(serverName(snapshot))
                .ifPresent(server -> proxy.unregisterServer(server.getServerInfo()));
    }

    private void update(ServerSnapshot snapshot) {
        ServerSnapshot previous = snapshots.put(snapshot.instanceId(), snapshot);
        if (previous != null && !serverName(previous).equals(serverName(snapshot))) {
            proxy.getServer(serverName(previous))
                    .ifPresent(server -> proxy.unregisterServer(server.getServerInfo()));
        }
        register(snapshot);
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
        return selectHub(null);
    }

    private Optional<RegisteredServer> selectHub(RegisteredServer excluded) {
        return snapshots.values().stream()
                .filter(ServerSnapshot::isHubTarget)
                .filter(snapshot -> proxy.getServer(serverName(snapshot))
                        .filter(server -> !server.equals(excluded))
                        .isPresent())
                .sorted(Comparator.comparingInt(this::effectivePlayerCount)
                        .thenComparing(ServerSnapshot::instanceId))
                .map(snapshot -> proxy.getServer(serverName(snapshot)))
                .flatMap(Optional::stream)
                .findFirst();
    }

    private int effectivePlayerCount(ServerSnapshot snapshot) {
        return proxy.getServer(serverName(snapshot))
                .map(server -> Math.max(
                        snapshot.playerCount(),
                        server.getPlayersConnected().size()
                ))
                .orElse(snapshot.playerCount());
    }

    private Optional<String> instanceId(RegisteredServer server) {
        return snapshots.values().stream()
                .filter(snapshot -> serverName(snapshot).equals(
                        server.getServerInfo().getName()
                ))
                .map(ServerSnapshot::instanceId)
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
        return RegistryReconciliation.serverName(snapshot);
    }

    private static String environment(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }
}
