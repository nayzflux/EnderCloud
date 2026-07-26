# Intégration d’un plugin de mini-jeu avec EnderCloud

Ce document décrit le contrat entre un plugin de mini-jeu Paper et EnderCloud.

Le plugin de mini-jeu reste responsable des règles de jeu, des téléportations, des kits, des
inventaires, de la victoire et des résultats. EnderCloud est responsable de la file d’attente,
de la création d’instance, du transfert Velocity, de l’assignation des équipes et du cycle de
vie de la session.

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
- un variant.yml dont group correspond à un groupe de type minigame.

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
        CompletableFuture<QueueResult> enqueue(QueueRequest request);
        CompletableFuture<Boolean> leaveQueue(String groupId, String partyId);
        Optional<SessionAssignment> currentAssignment();
        CompletableFuture<Void> reportGameStarting(String sessionId);
        CompletableFuture<Void> reportGameStarted(String sessionId);
        CompletableFuture<Void> reportGameFinished(
                String sessionId,
                Map<String, Object> results);
    }

## Cycle de vie d’une partie

    Joueurs dans le hub
        │ enqueue(party)
        ▼
    File d’attente
        │ minimum_players atteint
        ▼
    Session créée + équipes assignées
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

        for (SessionAssignment.AssignedPlayer player : assignment.players()) {
            UUID uuid = UUID.fromString(player.playerId());
            int team = player.teamIndex();
            // Téléportation, kit et sidebar selon team.
        }
    });

Une assignation contient sessionId, groupId, l’état de session, une revision et la liste des
joueurs. Chaque joueur contient son UUID, sa party, son teamIndex et son état.

Les états d’un joueur sont SELECTED, TRANSFERRING, CONNECTED et LEFT.

Le plugin doit utiliser teamIndex. Il ne doit pas déduire les équipes à partir de l’ordre
d’arrivée des joueurs.

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

Tant qu’une session est en TRANSFERRING ou WAITING et que son délai n’est pas dépassé,
l’orchestrateur peut ajouter une party à une équipe disponible.

Le plugin doit :

1. relire l’assignation quand sa revision augmente ;
2. ajouter les nouveaux joueurs à leur teamIndex ;
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

    matchmaking:
      minimum_players: 4
      maximum_players: 12
      team_count: 12
      team_size: 1
      waiting_timeout: 45s

Exemple de variante :

    id: skywars-solo-japan
    group: skywars-solo
    enabled: true
    revision: 1
    weight: 100

La capacité maximale doit respecter maximum_players <= team_count * team_size. Une party
supérieure à team_size est refusée à l’inscription.

## Responsabilités

| Responsabilité | EnderCloud | Plugin mini-jeu |
|---|:---:|:---:|
| File d’attente | Oui | Utilise enqueue / leaveQueue |
| Création d’instance | Oui | Non |
| Transfert Velocity | Oui | Non |
| Assignation d’équipe | Oui | Lit teamIndex |
| Téléportation dans la map | Non | Oui |
| Kits et inventaires | Non | Oui |
| Détection de victoire | Non | Oui |
| Calcul des résultats | Non | Oui |
| Stockage des résultats | Oui | Publie GAME_FINISHED |
| Présence des joueurs | Bridge Paper | Réagit aux événements Bukkit |

## Erreurs fréquentes

- utiliser un groupId de hub ;
- inscrire une party plus grande que team_size ;
- ignorer les changements de revision ;
- démarrer avant que les joueurs soient connectés ;
- appeler une API asynchrone en bloquant le thread principal ;
- publier GAME_STARTED sans GAME_STARTING ;
- continuer une ancienne session après un changement de sessionId ;
- republier les heartbeats déjà envoyés par le bridge.

## Checklist de mise en production

- Le groupe et la variante sont activés et synchronisés.
- Le bridge Paper et le plugin du mini-jeu sont dans le template.
- Les variables ENDERCLOUD_INSTANCE_ID et ENDERCLOUD_ORCHESTRATOR_URL sont disponibles.
- Le plugin récupère EnderCloudPaperApi via ServicesManager.
- L’inscription et l’annulation de file ont été testées.
- Les équipes sont calculées à partir de teamIndex.
- Les nouvelles revisions sont prises en compte.
- GAME_STARTING, GAME_STARTED et GAME_FINISHED ne sont envoyés qu’une fois.
- Les erreurs réseau sont journalisées sans bloquer Paper.
