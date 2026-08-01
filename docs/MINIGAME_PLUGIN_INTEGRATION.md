# Intégration d’un plugin de mini-jeu avec EnderCloud

Ce document décrit le contrat entre un plugin de mini-jeu Paper et EnderCloud.

Le plugin de mini-jeu reste responsable des règles de jeu, des téléportations, des kits, des
inventaires, de la victoire et des résultats. EnderCloud est responsable de la file d’attente,
de la création d’instance, du transfert Velocity, du calcul des profils d’équipes réalisables et
du cycle de vie de la session. Le plugin choisit l’affectation finale.

## Architecture

    Plugin mini-jeu Paper
            │ Bukkit ServicesManager
            ▼
    EnderCloudPaperPlugin
            │ HTTP privé
            ▼
    Orchestrateur EnderCloud
            │ Redis / Docker / PostgreSQL
            ▼
    Velocity + instance Paper

Le plugin ne doit pas appeler directement PostgreSQL, Redis ou Docker. Il utilise le service
Bukkit EnderCloudPaperApi, fourni par le bridge Paper EnderCloud.

## Installation et prérequis

La variante EnderCloud doit contenir :

- EnderCloudPaper-0.1.0.jar dans plugins/ ;
- le plugin du mini-jeu ;
- la map et la configuration complète du mode ;
- un variant final référencé par un groupe de type minigame, avec ses couches ordonnées.

Le bridge Paper utilise :

    ENDERCLOUD_INSTANCE_ID       Identifiant de l’instance
    ENDERCLOUD_ORCHESTRATOR_URL  URL HTTP privée de l’orchestrateur
    ENDERCLOUD_REPORTED_ENDPOINT Optionnel, endpoint annoncé à Velocity

Le plugin du mini-jeu peut déclarer une soft-dépendance envers EnderCloud.

L’API Java est disponible en compileOnly via plugins/core. Le bridge Paper fournit le service
à l’exécution.

## Récupérer l’API

    EnderCloudPaperApi cloud = Bukkit.getServicesManager()
            .load(EnderCloudPaperApi.class);

    if (cloud == null) {
        getLogger().severe("EnderCloud Paper bridge is unavailable");
        getServer().getPluginManager().disablePlugin(this);
        return;
    }

Les méthodes réseau sont asynchrones. Ne pas utiliser get() ou join() sur le thread principal
de Paper.

## API disponible

    public interface EnderCloudPaperApi {
        CompletableFuture<Boolean> sendToHub(UUID playerId);
        CompletableFuture<HubTransferResult> sendToHub(Collection<UUID> playerIds);

        CompletableFuture<QueueResult> enqueue(QueueRequest request);
        CompletableFuture<Boolean> leaveQueue(String groupId, String partyId);
        Optional<SessionAssignment> currentAssignment();
        CompletableFuture<Void> reportGameStarting(String sessionId);
        CompletableFuture<Void> reportGameStarted(String sessionId);
        CompletableFuture<Void> reportPlayerEliminated(String sessionId, UUID playerId);
        CompletableFuture<Void> reportGameFinished(
                String sessionId,
                Map<String, Object> results);
    }

## Cycle de vie d’une partie

    Joueurs dans le hub
        │ enqueue(party)
        ▼
    FORMING
        │ profil minimal réalisable
        ▼
    WAITING_FOR_INSTANCE / TRANSFERRING
        │ transfert Velocity
        ▼
    WAITING
        │ préparation du mini-jeu
        ├─ GAME_STARTING
        ├─ GAME_STARTED
        ▼
    RUNNING
        │ partie terminée
        └─ GAME_FINISHED

États utiles :

| État | Signification |
|---|---|
| FORMING | La session collecte des tickets hors serveur. |
| WAITING_FOR_INSTANCE | La session attend un serveur disponible. |
| TRANSFERRING | Les joueurs sont transférés vers l’instance. |
| WAITING | L’instance attend les arrivées ou le remplissage. |
| STARTING | Le mini-jeu prépare son démarrage définitif. |
| RUNNING | La partie est officiellement démarrée. |
| FINISHED | Les résultats sont enregistrés. |
| CANCELLED / FAILED | La session ne peut pas continuer. |

## Inscrire une party dans la file

Une entrée de file correspond à une party atomique. EnderCloud ne sépare jamais ses joueurs.

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

Règles :

- groupId doit être un groupe minigame activé ;
- la party doit contenir au moins un joueur ;
- les UUID doivent être distincts ;
- la party ne doit pas dépasser team_size ;
- un joueur ne peut pas être dans deux files ou sessions actives ;
- partyId doit rester stable pendant l’opération.

Une erreur de validation ou de conflit doit être affichée comme un échec d’inscription. Les
conflits utilisent généralement HTTP 409.

## Quitter la file

    cloud.leaveQueue("skywars-solo", "party-42")
            .thenAccept(removed -> {
                if (!removed) {
                    getLogger().info("Party was not queued");
                }
            });

Après la sélection d’une session, cette méthode ne retire pas automatiquement un joueur de la
partie. La politique de déconnexion/reconnexion appartient au plugin.

## Lire l’assignation

Le bridge Paper actualise régulièrement l’assignation :

    cloud.currentAssignment().ifPresent(assignment -> {
        String sessionId = assignment.sessionId();
        List<Integer> recommendedProfile = assignment.recommendedProfile();

        for (SessionAssignment.AssignedPlayer player : assignment.players()) {
            UUID uuid = UUID.fromString(player.playerId());
            String partyId = player.partyId();
            String ticketId = player.ticketId();
            // Le plugin place les tickets dans des équipes compatibles avec le profil.
        }
    });

Une assignation contient sessionId, groupId, l’état de session, une revision, les comptes attendus
et connectés, `acceptingTickets`, `lockEligible`, les profils réalisables et le profil recommandé.
Chaque joueur contient son UUID, sa party, le `ticketId` de cette inscription et son état.

`lockEligible` est une indication calculée depuis la politique d’équilibrage, pas une autorisation :
le plugin conserve l’autorité sur `GAME_STARTING`, que l’orchestrateur accepte sans deadline de
démarrage partiel.

Les états d’un joueur sont SELECTED, TRANSFERRING, CONNECTED et LEFT.

Les profils sont anonymes et triés. Le plugin mini-jeu reste responsable de l’affectation finale
des tickets aux équipes ; il doit conserver chaque `ticketId` indivisible et produire le profil
choisi. Deux tickets successifs peuvent partager le même `partyId`, notamment lorsqu’un joueur
quitte puis revient en file.

## Démarrer le mini-jeu

Le plugin décide quand tous les prérequis sont réunis : joueurs présents, équipes préparées,
map initialisée et inventaires prêts.

    cloud.reportGameStarting(sessionId)
            .exceptionally(error -> {
                getLogger().warning("Unable to report STARTING: " + error.getMessage());
                return null;
            });

Après la préparation finale :

    cloud.reportGameStarted(sessionId)
            .exceptionally(error -> {
                getLogger().warning("Unable to report RUNNING: " + error.getMessage());
                return null;
            });

Ne pas envoyer GAME_STARTED avant GAME_STARTING. Chaque notification doit être envoyée une
seule fois pour une session.

## Libérer un joueur éliminé

Lorsqu’un joueur est définitivement éliminé d’une partie en cours, le plugin doit le libérer de
la session avant de tenter une nouvelle inscription :

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

Il faut attendre la réussite de `reportPlayerEliminated` avant d’appeler `enqueue`. EnderCloud
marque alors le joueur comme sorti de l’ancienne session, mais le conserve dans le comptage du
serveur : il peut donc rester spectateur jusqu’au transfert vers sa prochaine partie. L’événement
n’est accepté que pour un joueur appartenant à une session `RUNNING` de cette instance.

EnderCloud ne reconstruit pas la composition précédente de la party. La nouvelle demande est
validée uniquement à partir des UUID qu’elle contient ; le plugin mini-jeu reste responsable de
la cohérence de cette composition.

## Annuler la partie

Si le mini-jeu ne peut plus continuer, il doit signaler explicitement l’annulation :

    cloud.reportGameCancelled(sessionId, "not enough teams")
            .exceptionally(error -> {
                getLogger().warning("Unable to report CANCELLED: " + error.getMessage());
                return null;
            });

`GAME_CANCELLED` est accepté pendant le transfert, l’attente, le démarrage ou une partie déjà
lancée. EnderCloud ferme immédiatement les transferts entrants, retire l’instance du registre
Velocity et transfère activement les joueurs présents vers les hubs disponibles. L’évacuation est
réessayée tant que l’instance contient des joueurs. `timeouts.cancelled_drain`, égal à 10 secondes
dans l’exemple, constitue la deadline de sécurité avant l’arrêt forcé du serveur.

## Terminer la partie

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

Les résultats sont libres mais doivent rester sérialisables et utiliser des clés stables, par
exemple winner, placements, scores et durationSeconds.

## Arrivées, déconnexions et heartbeat

Le bridge Paper publie automatiquement :

- PLAYER_JOINED lors de l’arrivée d’un joueur ;
- PLAYER_LEFT lors de sa déconnexion ;
- HEARTBEAT périodiquement avec la liste complète des joueurs présents.

Le plugin de mini-jeu n’a normalement pas besoin de republier ces événements. Il doit seulement
écouter les événements Bukkit nécessaires à sa logique.

Le heartbeat permet à EnderCloud de corriger les états après une déconnexion ou un redémarrage.

## Backfill et changement de revision

Tant qu’une session est en FORMING, WAITING_FOR_INSTANCE, TRANSFERRING ou WAITING et que
`lobby_stale` n’est pas atteint, l’orchestrateur peut lui ajouter un ticket compatible.
`GAME_STARTING` ferme définitivement le backfill.

Le plugin doit :

1. relire l’assignation quand sa revision augmente ;
2. recalculer son affectation finale à partir des parties et profils reçus ;
3. appliquer le même protocole de préparation ;
4. ne jamais déplacer un joueur déjà assigné ;
5. refuser les arrivées dès que le jeu est STARTING ou RUNNING.

Pour un mode sans arrivée tardive, utilisez un nombre fixe de joueurs et démarrez rapidement
après le transfert.

## Configuration du groupe

Exemple SkyWars Solo :

    id: skywars-solo
    type: minigame
    enabled: true

    variants:
      - id: skywars-solo-japan
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

    timeouts:
      startup: 90s
      drain: 15m
      cancelled_drain: 10s
      shutdown: 20s
      transfer: 20s
      player_stale: 30s
      instance_acquisition: 45s
      lobby_stale: 135s

Exemple BedWars 4v4v4v4 avec équilibrage des équipes :

    matchmaking:
      minimum_players: 8
      maximum_players: 16
      team_count: 4
      team_size: 4
      team_balance:
        minimum_players_per_team: 1
        maximum_team_spread: 2

Exemple de variante :

    id: skywars-solo-japan
    revision: 1
    parents:
      - skywars
      - skywars-solo

La capacité maximale doit respecter maximum_players <= team_count * team_size. Une party
supérieure à team_size est refusée à l’inscription.

## Responsabilités

| Responsabilité | EnderCloud | Plugin mini-jeu |
|---|:---:|:---:|
| File d’attente | Oui | Utilise enqueue / leaveQueue |
| Création d’instance | Oui | Non |
| Transfert Velocity | Oui | Non |
| Profils d’équipe réalisables | Oui | Choisit l’affectation finale |
| Téléportation dans la map | Non | Oui |
| Kits et inventaires | Non | Oui |
| Détection de victoire | Non | Oui |
| Calcul des résultats | Non | Oui |
| Stockage des résultats | Oui | Publie GAME_FINISHED |
| Annulation et évacuation | Oui | Publie GAME_CANCELLED |
| Présence des joueurs | Bridge Paper | Réagit aux événements Bukkit |

## Erreurs fréquentes

- utiliser un groupId de hub ;
- inscrire une party plus grande que team_size ;
- ignorer les changements de revision ;
- démarrer avant que les joueurs soient connectés ;
- appeler une API asynchrone en bloquant le thread principal ;
- publier GAME_STARTED sans GAME_STARTING ;
- arrêter directement le conteneur au lieu de publier GAME_CANCELLED ;
- continuer une ancienne session après un changement de sessionId ;
- republier les heartbeats déjà envoyés par le bridge.

## Checklist de mise en production

- Le groupe et la variante sont activés et synchronisés.
- Le bridge Paper et le plugin du mini-jeu sont dans le template.
- Les variables ENDERCLOUD_INSTANCE_ID et ENDERCLOUD_ORCHESTRATOR_URL sont disponibles.
- Le plugin récupère EnderCloudPaperApi via ServicesManager.
- L’inscription et l’annulation de file ont été testées.
- Les parties restent indivisibles et l’affectation finale respecte un profil réalisable.
- Les nouvelles revisions sont prises en compte.
- GAME_STARTING, GAME_STARTED, GAME_CANCELLED et GAME_FINISHED sont idempotents.
- Les erreurs réseau sont journalisées sans bloquer Paper.
