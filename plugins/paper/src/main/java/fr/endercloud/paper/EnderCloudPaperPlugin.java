package fr.endercloud.paper;

import fr.endercloud.core.api.EnderCloudPaperApi;
import fr.endercloud.core.http.EnderCloudClient;
import fr.endercloud.core.model.PaperEvent;
import fr.endercloud.core.model.QueueRequest;
import fr.endercloud.core.model.QueueResult;
import fr.endercloud.core.model.SessionAssignment;
import org.bukkit.Bukkit;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.ServicePriority;
import org.bukkit.plugin.java.JavaPlugin;

import java.net.URI;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;

public final class EnderCloudPaperPlugin extends JavaPlugin
        implements Listener, EnderCloudPaperApi {
    private final AtomicReference<SessionAssignment> assignment = new AtomicReference<>();
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

        String endpoint = System.getenv("ENDERCLOUD_REPORTED_ENDPOINT");
        publish(PaperEvent.serverReady(endpoint));
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
    public CompletableFuture<Void> reportGameStarting(String sessionId) {
        return orchestrator.publishEvent(instanceId, PaperEvent.gameStarting(sessionId));
    }

    @Override
    public CompletableFuture<Void> reportGameStarted(String sessionId) {
        return orchestrator.publishEvent(instanceId, PaperEvent.gameStarted(sessionId));
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

    private void sendHeartbeat() {
        List<java.util.UUID> playerIds = Bukkit.getOnlinePlayers().stream()
                .map(player -> player.getUniqueId())
                .toList();
        publish(PaperEvent.heartbeat(playerIds));
    }

    private void refreshAssignment() {
        orchestrator.getAssignment(instanceId)
                .thenAccept(optional -> optional.ifPresent(next -> {
                    SessionAssignment previous = assignment.get();
                    if (previous == null || previous.revision() < next.revision()) {
                        assignment.set(next);
                        orchestrator.acknowledgeAssignment(instanceId, next.revision())
                                .exceptionally(error -> {
                                    getLogger().warning(
                                            "Unable to acknowledge assignment: "
                                                    + error.getMessage()
                                    );
                                    return false;
                                });
                    } else {
                        assignment.set(next);
                    }
                }))
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
