# Minigame plugin integration

This guide defines the contract between a Paper minigame plugin and EnderCloud.

The minigame plugin owns game rules, team names, teleports, kits, inventories, victory detection,
and result calculation. EnderCloud owns queues, party selection, feasible team profiles, server
instances, Velocity transfers, session state, and result storage. The minigame plugin chooses the
final assignment of tickets to teams.

## Integration path

```text
Paper minigame plugin
        |
        | Bukkit ServicesManager
        v
EnderCloud Paper bridge
        |
        | Private HTTP
        v
EnderCloud orchestrator
        |
        | PostgreSQL, Redis, and host agents
        v
Velocity and managed Paper instances
```

The minigame plugin must not call PostgreSQL, Redis, Docker, or an execution agent. It uses
`EnderCloudPaperApi`, which the EnderCloud Paper bridge registers as a Bukkit service.

## Responsibilities

| Responsibility | EnderCloud | Minigame plugin |
| --- | :---: | :---: |
| Queue entries and atomic parties | Owns | Calls `enqueue` and `leaveQueue` |
| Feasible anonymous team profiles | Calculates | Chooses the final ticket-to-team mapping |
| Instance creation and placement | Owns | Does not manage |
| Velocity transfer | Owns | Does not manage |
| Assignment revision | Owns | Applies each new revision |
| Map initialization | Does not manage | Owns |
| Kits and inventories | Does not manage | Owns |
| Start decision | Accepts reported event | Owns |
| Victory and result calculation | Does not manage | Owns |
| Durable result storage | Stores event payload | Publishes `GAME_FINISHED` |
| Cancellation and evacuation | Executes | Publishes `GAME_CANCELLED` |
| Presence heartbeat | Paper bridge | Reacts to Bukkit events as needed |

## Installation

The effective final variant must contain:

- `EnderCloudPaper-0.1.0.jar` under `plugins/`;
- the minigame plugin JAR;
- the server JAR expected by the template's `CUSTOM_SERVER` setting;
- the map and complete mode configuration;
- a final `variant.yml` referenced by an enabled `minigame` group.

Compile against `EnderCloudCore-0.1.0.jar` without bundling it. For a plugin that keeps local API
JARs under `libs/`, a Gradle dependency can be:

```kotlin
dependencies {
    compileOnly(files("libs/EnderCloudCore-0.1.0.jar"))
}
```

The deployed Paper bridge provides the API classes and service implementation at runtime.

Declare a soft dependency in the minigame plugin's `plugin.yml`:

```yaml
softdepend:
  - EnderCloud
```

A soft dependency only controls load order. The plugin must still handle an absent service and
disable its EnderCloud-dependent behavior.

## Container environment

The Paper bridge reads:

| Variable | Required | Default | Purpose |
| --- | :---: | --- | --- |
| `ENDERCLOUD_INSTANCE_ID` | Yes | None | Stable managed instance ID |
| `ENDERCLOUD_ORCHESTRATOR_URL` | No | `http://localhost:8080` | Private orchestrator callback URL |
| `ENDERCLOUD_REPORTED_ENDPOINT` | No | Agent-allocated endpoint | Optional endpoint override for `SERVER_READY` |

The agent generates the first two values for managed containers. Most templates should not set an
endpoint override.

## Obtain the API

Load the service during plugin enable:

```java
EnderCloudPaperApi cloud = Bukkit.getServicesManager()
        .load(EnderCloudPaperApi.class);

if (cloud == null) {
    getLogger().severe("EnderCloud Paper bridge is unavailable");
    getServer().getPluginManager().disablePlugin(this);
    return;
}
```

Network methods return `CompletableFuture`. Never call `get()` or `join()` on Paper's main thread.
Handle success or failure asynchronously, then schedule Bukkit-only work back on the main thread
when required.

## API

The public interface is:

```java
public interface EnderCloudPaperApi {
    CompletableFuture<QueueResult> enqueue(QueueRequest request);
    CompletableFuture<Boolean> leaveQueue(String groupId, String partyId);
    Optional<SessionAssignment> currentAssignment();

    CompletableFuture<Boolean> sendToHub(UUID playerId);
    CompletableFuture<HubTransferResult> sendToHub(Collection<UUID> playerIds);

    CompletableFuture<Void> reportGameStarting(String sessionId);
    CompletableFuture<Void> reportGameStarted(String sessionId);
    CompletableFuture<Void> reportPlayerEliminated(String sessionId, UUID playerId);
    CompletableFuture<Void> reportGameCancelled(String sessionId, String reason);
    CompletableFuture<Void> reportGameFinished(
            String sessionId,
            Map<String, Object> results);
}
```

`currentAssignment()` is the only synchronous method. It reads the bridge's local cache and does
not perform a network request.

## Session lifecycle

```text
Players in a hub
    |
    | enqueue party
    v
FORMING
    |
    | feasible minimum profile
    v
WAITING_FOR_INSTANCE or TRANSFERRING
    |
    | Velocity transfers
    v
WAITING
    |
    | GAME_STARTING
    v
STARTING
    |
    | GAME_STARTED
    v
RUNNING
    |
    | GAME_FINISHED
    v
FINISHED
```

| State | Meaning for the game plugin |
| --- | --- |
| `FORMING` | The session is collecting tickets and has no locked game roster |
| `WAITING_FOR_INSTANCE` | The session is eligible but no server can be reserved yet |
| `TRANSFERRING` | EnderCloud is sending selected players to the reserved instance |
| `WAITING` | The instance is waiting for arrivals or compatible backfill |
| `STARTING` | The minigame plugin closed backfill and is performing final preparation |
| `RUNNING` | The match has officially started |
| `FINISHED` | EnderCloud stored the result payload |
| `CANCELLED` | The session was explicitly cancelled and players are being evacuated |
| `FAILED` | The session cannot continue because infrastructure or state failed |

The minigame plugin owns the move into `STARTING` and `RUNNING`. EnderCloud rejects skipped,
stale, or cross-instance transitions.

## Enqueue an atomic party

A queue request contains one group, one stable caller-supplied party ID, and distinct player UUIDs:

```java
QueueRequest request = new QueueRequest(
        "skywars-solo",
        "party-42",
        List.of(player1, player2)
);

cloud.enqueue(request).whenComplete((result, error) -> {
    if (error != null) {
        getLogger().warning("Unable to join queue: " + error.getMessage());
        return;
    }
    getLogger().info("Queue entry " + result.entryId()
            + " is now " + result.state());
});
```

The request must satisfy these rules:

- `groupId` names an enabled minigame group.
- The party contains at least one player.
- Player UUIDs are distinct.
- Party size does not exceed the group's `team_size`.
- No player belongs to another active queue entry or session.
- `partyId` remains stable while this enqueue attempt is active.

EnderCloud never splits the party. Validation and conflict responses complete the future
exceptionally. Active-membership conflicts normally use HTTP 409.

The returned `entryId` is the ticket identifier later exposed in assignments. A future enqueue
may reuse the same `partyId`, so do not treat `partyId` as a unique session ticket.

## Leave the queue

```java
cloud.leaveQueue("skywars-solo", "party-42")
        .thenAccept(removed -> {
            if (!removed) {
                getLogger().info("Party was not queued");
            }
        });
```

This removes a party only while its entry remains queued. After the matchmaker selects it into a
session, `leaveQueue` does not remove a player from the game. The minigame plugin owns its policy
for disconnects, reconnects, forfeits, and substitutes.

## Read and acknowledge assignments

The Paper bridge refreshes its assignment once per second and acknowledges each new revision.
Read the current cache without blocking:

```java
cloud.currentAssignment().ifPresent(assignment -> {
    String sessionId = assignment.sessionId();
    List<Integer> recommendedProfile = assignment.recommendedProfile();

    for (SessionAssignment.AssignedPlayer player : assignment.players()) {
        UUID uuid = UUID.fromString(player.playerId());
        String partyId = player.partyId();
        String ticketId = player.ticketId();
        // Place each indivisible ticket into teams compatible with the profile.
    }
});
```

An assignment contains:

- `sessionId`, `groupId`, session `state`, and numeric `revision`;
- `expectedPlayerCount` and `connectedPlayerCount`;
- `acceptingTickets` and `lockEligible` policy hints;
- all `feasibleProfiles` and one `recommendedProfile`;
- assigned players with UUID, `partyId`, `ticketId`, and player state.

Player states are `SELECTED`, `TRANSFERRING`, `CONNECTED`, and `LEFT`.

Profiles are anonymous sorted team sizes. The minigame plugin assigns indivisible tickets to its
actual teams and spawns. Every chosen team size must match one feasible profile. Never split
players that share a `ticketId`.

`lockEligible` means the current membership satisfies the configured team policy. It does not
start the game and does not remove the plugin's authority over `GAME_STARTING`.

## Handle backfill and assignment revisions

EnderCloud may add compatible tickets while a session is `FORMING`, `WAITING_FOR_INSTANCE`,
`TRANSFERRING`, or `WAITING`, provided its lobby deadline has not expired. `GAME_STARTING` closes
backfill.

When the assignment revision increases, the plugin must:

1. Read the complete new assignment.
2. Keep every already placed player on the same team.
3. Add new indivisible tickets without violating a feasible profile.
4. Update readiness checks for the new expected player count.
5. Reject arrivals once the game is `STARTING` or `RUNNING` according to the game's own policy.

For a mode that cannot support backfill, configure a fixed player count and publish
`GAME_STARTING` as soon as all required players and game assets are ready.

## Start the game

Publish `GAME_STARTING` only after the selected players, map, teams, kits, inventories, and other
game prerequisites are ready:

```java
cloud.reportGameStarting(sessionId)
        .exceptionally(error -> {
            getLogger().warning("Unable to report STARTING: " + error.getMessage());
            return null;
        });
```

After final preparation completes, publish `GAME_STARTED`:

```java
cloud.reportGameStarted(sessionId)
        .exceptionally(error -> {
            getLogger().warning("Unable to report RUNNING: " + error.getMessage());
            return null;
        });
```

Do not publish `GAME_STARTED` before `GAME_STARTING`. Network retries may resend the same event for
the same session and instance. Reuse the same `sessionId`; never continue sending events for an
assignment that has changed to another session.

## Release an eliminated player

When a player is permanently eliminated from a running game, release the player before trying to
enqueue them again:

```java
cloud.reportPlayerEliminated(sessionId, playerId)
        .thenCompose(ignored -> cloud.enqueue(new QueueRequest(
                "skywars-solo",
                nextPartyId,
                List.of(playerId)
        )))
        .exceptionally(error -> {
            getLogger().warning("Unable to requeue eliminated player: "
                    + error.getMessage());
            return null;
        });
```

Wait for `reportPlayerEliminated` to succeed before enqueueing. EnderCloud marks the player left in
the session but keeps the player in observed instance counts. The player may remain as a spectator
until a later transfer.

The event is valid only for a player in a `RUNNING` session assigned to the current instance.
EnderCloud does not reconstruct the player's previous party. The plugin must build and validate
the next party itself.

## Cancel a game

If the game cannot continue, report cancellation instead of stopping the container:

```java
cloud.reportGameCancelled(sessionId, "not enough teams")
        .exceptionally(error -> {
            getLogger().warning("Unable to report CANCELLED: " + error.getMessage());
            return null;
        });
```

`GAME_CANCELLED` is accepted while players are transferring, waiting, starting, or already
running. EnderCloud closes incoming transfers, removes the instance from the Velocity registry,
and schedules its connected players across available hubs. It retries evacuation while players
remain present.

The group's `timeouts.cancelled_drain` is the final safety deadline before EnderCloud proceeds to
forced shutdown. Do not call Docker or shut the server down directly, because that bypasses
durable cancellation and player evacuation.

## Finish a game

Result values are game-defined but must be serializable by the shared JSON mapper. Prefer stable,
documented keys:

```java
Map<String, Object> results = Map.of(
        "winner", winnerUuid.toString(),
        "durationSeconds", 642,
        "placements", Map.of(
                player1.toString(), 1,
                player2.toString(), 2
        )
);

cloud.reportGameFinished(sessionId, results)
        .exceptionally(error -> {
            getLogger().warning("Unable to report FINISHED: " + error.getMessage());
            return null;
        });
```

After `GAME_FINISHED`, the session is terminal and EnderCloud moves the instance through its normal
drain and shutdown policy.

## Send players to a hub

Use `sendToHub` when a player leaves a game voluntarily or the plugin needs a normal lobby return:

```java
cloud.sendToHub(player.getUniqueId())
        .thenAccept(accepted -> {
            if (!accepted) {
                getLogger().warning("No hub transfer was accepted");
            }
        });
```

For several players, the batch result separates accepted and rejected UUIDs:

```java
cloud.sendToHub(playerIds).thenAccept(result -> {
    result.acceptedPlayers().forEach(id ->
            getLogger().fine("Hub transfer accepted for " + id));
    result.rejectedPlayers().forEach(id ->
            getLogger().warning("Hub transfer rejected for " + id));
});
```

EnderCloud balances accepted players across the least-loaded running hubs. The completed future
means the durable transfer was scheduled. It does not wait for the player to arrive.

## Presence and heartbeat

The Paper bridge automatically publishes:

- `SERVER_READY` until the orchestrator acknowledges startup;
- `PLAYER_JOINED` for a Bukkit join;
- `PLAYER_LEFT` for a Bukkit quit;
- `HEARTBEAT` every ten seconds with all connected UUIDs and Paper TPS averages for 1, 5, and 15
  minutes.

The minigame plugin should not duplicate these events. It only needs Bukkit listeners for its own
game state.

Heartbeats let EnderCloud repair presence after a lost event or orchestrator restart. The TPS
block is optional in the HTTP contract so older bridge versions remain compatible.

## Group configuration example

```yaml
id: skywars-solo
type: minigame
enabled: true

variants:
  - id: sw-1s-japan
    enabled: true
    weight: 100

matchmaking:
  minimum_players: 4
  maximum_players: 12
  team_count: 12
  team_size: 1
  candidate_window: 20
  team_balance:
    minimum_players_per_team: 0
    maximum_team_spread: 1

capacity:
  minimum_instances: 0
  maximum_instances: 20
  minimum_warm_instances: 1
  maximum_warm_instances: 4

timeouts:
  startup: 90s
  drain: 15m
  cancelled_drain: 10s
  shutdown: 20s
  transfer: 20s
  player_stale: 30s
  instance_acquisition: 45s
  lobby_stale: 135s
```

The matching final variant could be:

```yaml
id: sw-1s-japan
revision: 2
parents:
  - skywars
  - skywars-solo

environment:
  MAP_ID: japan
```

`maximum_players` must not exceed `team_count * team_size`. An enqueue request must not contain
more players than `team_size`.

See [the group reference](../groups/GROUP.md) for every field.

## Common mistakes

- Enqueueing into a hub group.
- Sending a party larger than `team_size`.
- Blocking Paper's main thread on a returned future.
- Ignoring assignment revision changes.
- Splitting one `ticketId` across teams.
- Publishing `GAME_STARTED` before `GAME_STARTING`.
- Starting before selected players and game assets are ready.
- Reusing an old `sessionId` after the assignment changes.
- Stopping the container instead of publishing `GAME_CANCELLED`.
- Requeueing an eliminated player before the elimination future completes.
- Republishing presence events already sent by the Paper bridge.

## Release checklist

- The group and final variant are enabled and visible in the dashboard.
- The final variant revision matches the template content being deployed.
- The Paper bridge and minigame JAR are present in the effective layer stack.
- `ENDERCLOUD_INSTANCE_ID` and `ENDERCLOUD_ORCHESTRATOR_URL` reach the Paper process.
- The plugin loads `EnderCloudPaperApi` through `ServicesManager`.
- Enqueue, leave, and active-membership conflicts have been tested.
- Parties remain indivisible in every final team assignment.
- New assignment revisions preserve already placed players.
- Game lifecycle retries reuse the same current `sessionId`.
- Cancellation evacuates players before shutdown.
- Network failures are logged without blocking Paper's main thread.
