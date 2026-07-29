package fr.nayz.endercloud.paper;

import org.bukkit.Bukkit;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.ServicePriority;
import org.bukkit.plugin.java.JavaPlugin;

import fr.nayz.endercloud.core.api.EnderCloudPaperApi;
import fr.nayz.endercloud.core.http.EnderCloudClient;
import fr.nayz.endercloud.core.model.PaperEvent;
import fr.nayz.endercloud.core.model.HubTransferResult;
import fr.nayz.endercloud.core.model.QueueRequest;
import fr.nayz.endercloud.core.model.QueueResult;
import fr.nayz.endercloud.core.model.SessionAssignment;

import java.net.URI;
import java.util.List;
import java.util.Collection;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public final class EnderCloudPaperPlugin extends JavaPlugin
        implements Listener, EnderCloudPaperApi {
    private final AtomicReference<SessionAssignment> assignment = new AtomicReference<>();
    private final AtomicInteger acknowledgedRevision = new AtomicInteger();
    private final AtomicBoolean serverReadyAcknowledged = new AtomicBoolean();
    private EnderCloudClient orchestrator;
    private String instanceId;

    @Override
    public void onEnable() {
        instanceId = System.getenv("ENDERCLOUD_INSTANCE_ID");
        String orchestratorUrl = environment(
                "ENDERCLOUD_ORCHESTRATOR_URL",
                "http://localhost:8080"
        );
        if (instanceId == null || instanceId.isBlank()) {
            getLogger().severe("ENDERCLOUD_INSTANCE_ID is required");
            getServer().getPluginManager().disablePlugin(this);
            return;
        }

        orchestrator = new EnderCloudClient(URI.create(orchestratorUrl));
        getServer().getPluginManager().registerEvents(this, this);
        getServer().getServicesManager().register(
                EnderCloudPaperApi.class,
                this,
                this,
                ServicePriority.Normal
        );

        publishServerReady();
        Bukkit.getScheduler().runTaskTimerAsynchronously(
                this,
                () -> {
                    if (!serverReadyAcknowledged.get()) publishServerReady();
                },
                100L,
                100L
        );
        Bukkit.getScheduler().runTaskTimer(this, this::sendHeartbeat, 200L, 200L);
        Bukkit.getScheduler().runTaskTimerAsynchronously(
                this,
                this::refreshAssignment,
                20L,
                20L
        );
        getLogger().info("EnderCloud Paper bridge is ready for instance " + instanceId);
    }

    @Override
    public void onDisable() {
        getServer().getServicesManager().unregisterAll(this);
        if (orchestrator != null) orchestrator.close();
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onJoin(PlayerJoinEvent event) {
        publish(PaperEvent.playerJoined(
                event.getPlayer().getUniqueId(),
                Optional.ofNullable(assignment.get())
                        .map(SessionAssignment::sessionId)
                        .orElse(null)
        ));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent event) {
        publish(PaperEvent.playerLeft(
                event.getPlayer().getUniqueId(),
                Optional.ofNullable(assignment.get())
                        .map(SessionAssignment::sessionId)
                        .orElse(null)
        ));
    }

    @Override
    public CompletableFuture<QueueResult> enqueue(QueueRequest request) {
        return orchestrator.enqueue(request);
    }

    @Override
    public CompletableFuture<Boolean> leaveQueue(String groupId, String partyId) {
        return orchestrator.leaveQueue(groupId, partyId);
    }

    @Override
    public Optional<SessionAssignment> currentAssignment() {
        return Optional.ofNullable(assignment.get());
    }

    @Override
    public CompletableFuture<Boolean> sendToHub(java.util.UUID playerId) {
        return sendToHub(List.of(playerId))
                .thenApply(result -> result.accepted(playerId));
    }

    @Override
    public CompletableFuture<HubTransferResult> sendToHub(
            Collection<java.util.UUID> playerIds
    ) {
        return orchestrator.sendToHub(instanceId, playerIds);
    }

    @Override
    public CompletableFuture<Void> reportGameStarting(String sessionId) {
        return orchestrator.publishEvent(instanceId, PaperEvent.gameStarting(sessionId));
    }

    @Override
    public CompletableFuture<Void> reportGameStarted(String sessionId) {
        return orchestrator.publishEvent(instanceId, PaperEvent.gameStarted(sessionId));
    }

    @Override
    public CompletableFuture<Void> reportGameCancelled(String sessionId, String reason) {
        return orchestrator.publishEvent(
                instanceId,
                PaperEvent.gameCancelled(sessionId, reason)
        );
    }

    @Override
    public CompletableFuture<Void> reportGameFinished(
            String sessionId,
            Map<String, Object> results
    ) {
        return orchestrator.publishEvent(
                instanceId,
                PaperEvent.gameFinished(sessionId, results)
        );
    }

    private void publishServerReady() {
        String endpoint = System.getenv("ENDERCLOUD_REPORTED_ENDPOINT");
        orchestrator.publishEvent(instanceId, PaperEvent.serverReady(endpoint))
                .thenRun(() -> serverReadyAcknowledged.set(true))
                .exceptionally(error -> {
                    getLogger().warning(
                            "Unable to confirm SERVER_READY: " + error.getMessage()
                    );
                    return null;
                });
    }

    private void sendHeartbeat() {
        List<java.util.UUID> playerIds = Bukkit.getOnlinePlayers().stream()
                .map(player -> player.getUniqueId())
                .toList();
        publish(PaperEvent.heartbeat(playerIds));
    }

    private void refreshAssignment() {
        orchestrator.getAssignment(instanceId)
                .thenAccept(optional -> {
                    if (optional.isEmpty()) {
                        assignment.set(null);
                        acknowledgedRevision.set(0);
                        return;
                    }
                    SessionAssignment next = optional.orElseThrow();
                    assignment.set(next);
                    if (acknowledgedRevision.get() >= next.revision()) return;
                    orchestrator.acknowledgeAssignment(instanceId, next.revision())
                            .thenAccept(acknowledged -> {
                                if (acknowledged) {
                                    acknowledgedRevision.accumulateAndGet(
                                            next.revision(),
                                            Math::max
                                    );
                                }
                            })
                            .exceptionally(error -> {
                                getLogger().warning(
                                        "Unable to acknowledge assignment: "
                                                + error.getMessage()
                                );
                                return null;
                            });
                })
                .exceptionally(error -> {
                    getLogger().warning("Unable to refresh assignment: " + error.getMessage());
                    return null;
                });
    }

    private void publish(PaperEvent event) {
        orchestrator.publishEvent(instanceId, event)
                .exceptionally(error -> {
                    getLogger().warning(
                            "Unable to publish " + event.type() + ": " + error.getMessage()
                    );
                    return null;
                });
    }

    private static String environment(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }
}
