# Deadlines et timeouts

EnderCloud distingue deux notions :

- un **timeout** est une durée configurée dans le server group ;
- une **deadline** est l’instant UTC absolu calculé et persisté lorsque l’étape commence.

L'orchestrateur lit les groupes au démarrage. Après une modification, il faut donc le redémarrer
pour synchroniser la nouvelle durée. Une deadline déjà persistée ne change pas. La nouvelle durée
s'applique seulement aux opérations créées après la synchronisation.

## Timeouts configurables par server group

Toutes les durées utilisent `ms`, `s`, `m` ou `h`.

| Clé `timeouts` | Groupes | Exemple | Départ | Deadline persistée | Effet à expiration |
| --- | --- | ---: | --- | --- | --- |
| `startup` | Tous | `90s` | Passage de l’instance à `STARTING` | `server_instances.startup_deadline` | L’instance devient `FAILED` si Paper n’a pas annoncé `SERVER_READY`. |
| `drain` | Tous | `15m` | Drain normal d’une instance | `server_instances.drain_deadline` avec raison `NORMAL` | L’instance est arrêtée même si des joueurs sont encore observés. |
| `cancelled_drain` | Tous | `10s` | Annulation d’une session minigame | `server_instances.drain_deadline` avec raison `SESSION_CANCELLED` | Borne l’évacuation active vers un hub avant l’arrêt forcé. |
| `shutdown` | Tous | `20s` | Passage à `STOPPING` | `server_instances.shutdown_deadline` | Délai accordé au serveur Minecraft avant l’arrêt Docker forcé. |
| `transfer` | Tous | `20s` | Création d’une commande de transfert | `transfer_commands.expires_at` et `session_players.transfer_deadline` | La commande expire et les joueurs de session non arrivés passent à `LEFT`. Le groupe cible fournit la durée. |
| `player_stale` | Tous | `30s` | Dernière observation d’un joueur | `instance_players.stale_deadline` | Le joueur est retiré du comptage et marqué parti de sa session. |
| `instance_lifetime` | Hub | `4h` | Passage du hub à `RUNNING` | `server_instances.renewal_deadline` | Démarre un remplaçant si une place est disponible, puis met l’ancien hub en drain lorsque le nouveau est prêt. |
| `instance_acquisition` | Minigame | `45s` | Session éligible sans instance chaude disponible | `game_sessions.instance_acquisition_deadline` | La session est annulée si aucune instance n’a été réservée. |
| `lobby_stale` | Minigame | `135s` | Début des transferts vers l’instance | `game_sessions.lobby_stale_deadline` | Annule une session qui n’a pas progressé vers `GAME_STARTING`. |

Le plugin minijeu possède l’autorité sur le démarrage. L’orchestrateur accepte son événement
`GAME_STARTING` sans attendre ni valider une deadline de démarrage partiel. `lobby_stale` est
uniquement un watchdog contre une session abandonnée.

### Présence, heartbeat et transfert

Le plugin Paper envoie environ toutes les dix secondes un heartbeat contenant la liste des joueurs
connectés. Chaque observation renouvelle la deadline `player_stale`. Si cette deadline expire,
l’orchestrateur considère seulement que son observation est périmée : il ne kicke pas le joueur.

La deadline `transfer` mesure plutôt le temps accordé à un joueur pour rejoindre le serveur cible
après l’émission d’une commande de transfert.

## Exemple

```yaml
timeouts:
  instance_lifetime: 4h # hubs uniquement
  startup: 90s
  drain: 15m
  cancelled_drain: 10s
  shutdown: 20s
  transfer: 20s
  player_stale: 30s
  instance_acquisition: 45s
  lobby_stale: 135s
```

`instance_lifetime` est absent des groupes minigame. Les deux dernières clés sont absentes des
groupes `hub`.

La deadline de renouvellement est persistée au premier passage à `RUNNING` et ne change pas lors
d’une modification ultérieure du timeout. `maximum_instances` reste une limite absolue : un hub
expiré continue d’accepter les joueurs si aucune place n’est disponible pour son remplaçant.

## Compatibilité

Les anciens champs `lifecycle.startup_timeout`, `lifecycle.draining_timeout`,
`lifecycle.shutdown_timeout`, `matchmaking.waiting_timeout`,
`matchmaking.instance_wait_timeout` et `matchmaking.maximum_waiting_timeout` restent acceptés
temporairement. L’orchestrateur journalise un avertissement lorsqu’il les rencontre et refuse un
fichier qui définit simultanément l’ancien et le nouveau nom d’une même durée.

`timeouts.ineligible_lobby` reste temporairement accepté comme alias de `timeouts.lobby_stale`.
`timeouts.partial_start` est accepté mais ignoré avec un avertissement : le plugin décide désormais
seul quand démarrer. La politique d’équilibrage anciennement nommée
`matchmaking.partial_start` devient `matchmaking.team_balance`.

`TRANSFER_TIMEOUT_MS` et `CANCELLED_DRAIN_TIMEOUT_MS` restent disponibles comme fallbacks
dépréciés pour les anciens fichiers. Les nouveaux groupes doivent déclarer leurs durées dans
`timeouts`.

## Délais techniques non liés aux groupes

| Délai | Valeur actuelle | Rôle |
| --- | ---: | --- |
| Proxy dashboard vers orchestrateur | `8s` | Annule une requête dashboard bloquée. |
| Client HTTP Java | `10s` | Timeout de connexion et de requête des plugins Paper/Velocity. |
| Sonde orchestrateur vers agent | `3s` par défaut | Borne les inventaires et sondes courtes. Configurable avec `AGENT_PROBE_TIMEOUT_MS`. |
| Opération orchestrateur vers agent | `10m` par défaut | Borne une création ou suppression longue. Configurable avec `AGENT_OPERATION_TIMEOUT_MS`. |
| Heartbeat agent | `5s` par défaut | Fréquence d'annonce d'un agent. Configurable avec `AGENT_HEARTBEAT_INTERVAL_MS`. |
| Détection d'un hôte hors ligne | `30s` par défaut | Passe un hôte sans activité à `OFFLINE`. Configurable avec `HOST_OFFLINE_AFTER_MS`. |
| Connexion PostgreSQL | `10s` | Borne l’établissement d’une connexion. |
| Connexion PostgreSQL inactive | `20s` | Ferme une connexion inutilisée du pool. |
| Fermeture PostgreSQL | `10s` | Borne l’arrêt gracieux de l’orchestrateur. |
| Retry Redis | `250ms` exponentiel, maximum `5s` | Reconnexion du bus Redis. |
| Retry d’un transfert | `2s`, puis maximum `30s` | Réémet une commande durable jusqu’à son expiration. |
| Healthchecks Compose | `3s` | Borne chaque sonde d’infrastructure. |

Les intervalles `CAPACITY_INTERVAL_MS`, `MATCHMAKING_INTERVAL_MS` et
`HOST_RECONCILE_INTERVAL_MS` pilotent la fréquence des boucles de contrôle. Ce ne sont pas des
deadlines. `RECONCILE_INTERVAL_MS` n'est plus utilisé.
