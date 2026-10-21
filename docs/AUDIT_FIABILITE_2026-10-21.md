# Audit de fiabilité — 21 octobre 2026

Analyse du code local, sans correction du code applicatif. Les modifications déjà présentes dans le répertoire de travail ont été conservées.

Le socle est solide : transactions PostgreSQL, commandes de création persistées, réservations de ressources, délais enregistrés et réconciliation des conteneurs. Les défauts identifiés concernent surtout la reprise après un échec partiel et les opérations concurrentes. Les tests existants ne couvrent pas plusieurs de ces situations.

**Bilan : 14 problèmes, dont 9 reproduits par des vérifications ciblées et 5 constatés par lecture du code.** P1 désigne une correction prioritaire avant exploitation exigeant une reprise automatique ; P2 désigne une amélioration de robustesse à planifier. Les niveaux supposent le déploiement prévu : un orchestrateur et des API sur un réseau de confiance.

## Vérifications effectuées

| Vérification | Résultat |
| --- | --- |
| Orchestrateur : `bun run typecheck` | Réussi |
| Orchestrateur : `bun run test:unit` | 80 tests réussis |
| Orchestrateur : `bun run test:integration` | 57 tests réussis, bases PostgreSQL temporaires Testcontainers |
| Dashboard : `bun test` | 63 tests réussis |
| Dashboard : `bun run typecheck` | Réussi |
| Scénarios ciblés supplémentaires | 5 reproductions sur PostgreSQL temporaire et 4 simulations ciblées |

Les deux premiers échecs unitaires étaient des erreurs `EPERM` de renommage dans le répertoire temporaire Windows du bac à sable. La suite complète passe avec `TEMP` et `TMP` dirigés vers `.cache/bun-tmp` dans le projet.

Les reproductions emploient les classes applicatives existantes. Les appels Docker/Redis et certaines erreurs de dépendances sont simulés ; aucune panne n'a été provoquée dans une infrastructure applicative existante. Les conteneurs PostgreSQL temporaires ont été supprimés après utilisation. Les tests Java, les tests navigateur et une partie réelle avec Paper/Velocity n'ont pas été exécutés. Les constats Java sont donc issus de l'analyse statique. Cet audit ne prétend pas prouver l'absence d'autres défauts.

## 1. P1 — Une variante peut rester définitivement bloquée en `PROBING`

**Emplacements :** [filtrage des variantes](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/variant-selector.ts:60), [traitement des échecs](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/instance-controller.ts:139), [réconciliation de la politique](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/variant-start-controller.ts:331), [réinitialisation manuelle](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/variant-start-controller.ts:292).

**Déclenchement :** après un premier échec, une nouvelle tentative passe en `PROBING`. Son hôte tombe ou entre en maintenance avant `SERVER_READY`. Ces causes ne sont pas comptabilisées comme des erreurs de variante, mais elles ne libèrent pas non plus la tentative de vérification.

**Conséquence :** aucune nouvelle instance de cette variante ne peut être sélectionnée. La réconciliation ne répare que les états `RESETTING`, et la réinitialisation manuelle refuse `PROBING`. Un simple redémarrage avec la même configuration ne débloque pas cet état.

**Preuve :** reproduction sur PostgreSQL : instance échouée pour `HOST_OFFLINE`, politique toujours `PROBING`, sélection de variante `null`, demande de réinitialisation `CONFLICT`.

**Solutions proposées :**

- Recommandation : réconcilier aussi `PROBING`. Si sa tentative est terminale, revenir en `BACKING_OFF` avec un délai d'infrastructure, sans augmenter le compteur d'échecs de la variante.
- Ajouter un délai maximal de vérification persistant et permettre une remise à zéro contrôlée d'une tentative abandonnée.

**Validation attendue :** perte d'hôte et maintenance pendant `PROBING`, puis reprise sur un autre hôte sans changement de révision.

## 2. P1 — Une panne Redis peut empêcher l'enregistrement durable d'un échec de démarrage

**Emplacement :** [fin de `failInstance`](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/instance-controller.ts:138).

**Déclenchement :** `failInstance` valide `FAILED` en base, puis attend la publication de désinscription Redis avant d'appeler `recordFailure`. Redis échoue à cet instant.

**Conséquence :** la politique de nouvelle tentative n'est pas mise à jour. Un nouvel appel retourne immédiatement parce que l'instance est déjà `FAILED`. La réconciliation peut nettoyer l'instance, mais ne reconstitue pas cette comptabilisation. Le délai progressif et la limite d'échecs peuvent être contournés.

**Preuve :** reproduction PostgreSQL avec échec Redis injecté : instance `FAILED`, politique absente, deuxième appel retournant `false`.

**Solutions proposées :**

- Recommandation : persister la transition d'échec, sa comptabilisation idempotente et un événement à publier dans une même transaction. Un worker publie ensuite les événements persistés.
- Correctif plus limité : traiter l'erreur Redis séparément, garantir l'exécution de la politique, puis rendre les effets incomplets rejouables par réconciliation. Réordonner les appels seul ne protège pas d'un crash entre eux.

**Validation attendue :** Redis indisponible à chaque étape, crash après validation en base, puis rejeu sans perdre ni doubler le compteur.

## 3. P1 — Un `CREATE` retardé peut créer un conteneur après la fin de son `DELETE`

**Emplacements :** [préparation de la création](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/executor/local-docker.ts:126), [verrou de création](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/executor/local-docker.ts:147), [suppression](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/executor/local-docker.ts:237).

**Déclenchement :** une création prépare ses fichiers puis attend l'image Docker. Pendant cette attente, une suppression de la même instance s'exécute et réussit. La création reprend ensuite. Le verrou protège uniquement l'allocation du port et la création Docker ; la suppression ne le partage pas.

**Conséquence :** un conteneur apparaît alors que sa suppression est terminée et que ses fichiers ont été retirés. La réconciliation pourra le nettoyer ultérieurement, mais la base peut avoir libéré ses ressources entre-temps. Deux créations simultanées peuvent également remplacer les fichiers d'une même instance avant le contrôle final du conteneur existant.

**Preuve :** exécuteur réel avec fichiers temporaires et Docker simulé : après un `DELETE` réussi, `created=true`, `started=true`, `runtimePresent=false`.

**Solutions proposées :**

- Recommandation : un verrou par `instanceId` couvrant toute la création, l'arrêt et la suppression, avec vérification de l'état désiré avant le lancement.
- Pour résister aux requêtes retardées et aux redémarrages de l'agent : conserver une génération d'opération ou une trace persistante de suppression et refuser les créations devenues obsolètes.

**Validation attendue :** téléchargement lent, expiration de la requête appelante, `DELETE`, puis arrivée tardive du `CREATE` ; deux `PUT` concurrents du même identifiant.

## 4. P1 — Une erreur du worker de démarrage peut arrêter tout l'orchestrateur

**Emplacements :** [promesse lancée sans gestion du rejet](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/instance-start-worker.ts:141), [requêtes avant le `try`](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/instance-controller.ts:351), [arrêt sur rejet non géré](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/index.ts:39).

**Déclenchement :** une requête SQL initiale de `executeCreate` échoue, ou le traitement d'une erreur échoue à son tour. `launch` ne possède qu'un `finally`, et sa promesse n'a pas de gestionnaire de rejet pendant le fonctionnement normal.

**Conséquence :** le rejet atteint le gestionnaire global, qui appelle `process.exit(1)`. Une erreur locale de démarrage peut donc interrompre toutes les fonctions de contrôle.

**Preuve :** simulation ciblée de `launch` avec échec injecté : réception de `unhandledRejection` avec `temporary database failure`.

**Solutions proposées :**

- Recommandation : gérer le rejet à la frontière de chaque tâche et couvrir toute l'exécution de `executeCreate`, y compris ses premières lectures.
- Enregistrer un échec récupérable ou remettre la commande en attente avec délai. Si PostgreSQL est indisponible, conserver une procédure de récupération au rétablissement, sans masquer l'échec de persistance.

**Validation attendue :** échec des premières lectures et échec pendant le traitement d'une erreur ; les autres tâches doivent continuer.

## 5. P1 — La reprise peut ressusciter une session annulée

**Emplacement :** [mise à jour de reprise sans condition d'état](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/session-controller.ts:242).

**Déclenchement :** `recoverFailedInstances` lit une session et ses joueurs, puis effectue d'autres opérations. Une annulation intervient avant sa transaction de reprise. La mise à jour suivante filtre uniquement sur l'identifiant de session.

**Conséquence :** `CANCELLED` peut être remplacé par `WAITING_FOR_INSTANCE`. De même, un comptage de joueurs devenu obsolète peut provoquer une réaffectation inappropriée. Le chemin qui écrit `FAILED` présente aussi cette absence de vérification de l'état courant.

**Preuve :** reproduction PostgreSQL en insérant une annulation entre la lecture et l'écriture : état attendu `CANCELLED`, état obtenu `WAITING_FOR_INSTANCE`.

**Solutions proposées :**

- Recommandation : verrouiller la session dans la transaction de reprise, relire son état, son instance et ses joueurs, puis décider.
- Compléter avec des mises à jour conditionnelles sur l'état et l'instance attendus, et vérifier le nombre de lignes modifiées.

**Validation attendue :** annulation, arrivée d'un joueur et `GAME_STARTING` concurrents de la reprise.

## 6. P1 — Les instances d'un hôte hors ligne ne sont traitées qu'une fois

**Emplacements :** [condition sur le changement d'état de l'hôte](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/reconciler.ts:105), [erreurs individuelles absorbées](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/reconciler.ts:126).

**Déclenchement :** l'hôte passe en `OFFLINE`, mais le passage d'une de ses instances en échec rencontre une erreur SQL. Aux passages suivants, `markOffline` retourne `false` puisque l'hôte est déjà hors ligne.

**Conséquence :** cette instance n'est plus traitée par ce chemin tant que l'hôte reste inaccessible. Elle peut rester logiquement `RUNNING` et compter dans la capacité. Le registre des serveurs ne filtre pas non plus les hôtes hors ligne.

**Preuve :** simulation de deux passages : une seule tentative de transition de l'instance malgré son premier échec.

**Solutions proposées :**

- Recommandation : réconcilier les instances actives de tous les hôtes `OFFLINE` à chaque passage. Réserver la détection de transition au journal et aux notifications.
- En complément, filtrer les destinations de routage selon la santé de leur hôte.

**Validation attendue :** erreur sur une seule instance au premier passage, correction au passage suivant sans retour de l'agent.

## 7. P1 — Une session peut rester active pendant un nettoyage bloqué en `STOPPING`

**Emplacements :** [sélection des instances échouées](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/session-controller.ts:210), [passage en `STOPPING` avant les appels distants](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/instance-controller.ts:776).

**Déclenchement :** une instance échoue, puis la réconciliation commence son nettoyage avant le passage du contrôleur de sessions. L'instance devient `STOPPING`. Un appel d'arrêt ou de suppression reste lent ou échoue durablement.

**Conséquence :** `recoverFailedInstances` ne sélectionne que `FAILED` et `STOPPED` avec une cause d'échec. La session peut donc rester attachée à cette instance jusqu'à la fin du nettoyage ; pour une session déjà démarrée, aucun délai de lobby ne la libère.

**Preuve :** reproduction PostgreSQL : instance `STOPPING` avec `failureReason=RUNTIME_MISSING`, session conservée en `TRANSFERRING` après le passage de récupération.

**Solutions proposées :**

- Recommandation : dissocier la récupération logique des sessions du nettoyage physique ; considérer également `STOPPING` lorsqu'une cause d'échec est persistée.
- Conserver les réservations physiques jusqu'à suppression confirmée, même si la session est déjà échouée ou réaffectée.

**Validation attendue :** suppression distante indisponible pendant plusieurs passages ; la session doit néanmoins évoluer.

## 8. P1 — Un conteneur conservé pour diagnostic peut continuer à tourner indéfiniment

**Emplacements :** [conservation et arrêt du dernier runtime](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/variant-start-controller.ts:369), [exclusion de la réconciliation](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/reconciler.ts:184).

**Déclenchement :** la politique devient `BLOCKED`, marque `runtimeRetained=true`, puis l'arrêt du conteneur échoue. Cette erreur est journalisée. Les passages suivants excluent les instances `FAILED` conservées.

**Conséquence :** conserver les fichiers empêche aussi toute nouvelle tentative d'arrêt. Un serveur défaillant peut consommer des ressources indéfiniment.

**Preuve :** reproduction PostgreSQL avec arrêt en erreur puis rétabli : après deux réconciliations, une seule tentative d'arrêt, instance toujours `FAILED` et conservée.

**Solutions proposées :**

- Recommandation : distinguer « conserver les fichiers » et « conteneur confirmé arrêté ». Réessayer l'arrêt tant que l'inventaire le signale actif.
- Ajouter une échéance d'arrêt et, selon la politique choisie, un arrêt forcé avec incident si le délai est dépassé.

**Validation attendue :** premier arrêt en erreur, second réussi ; les fichiers de diagnostic doivent rester disponibles.

## 9. P2 — Un processus Minecraft bloqué peut rester considéré comme sain

**Emplacements :** [santé déduite de l'état Docker](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/reconciler.ts:158), [heartbeat Paper sans bail de santé d'instance](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/instance-controller.ts:1170).

**Constat statique :** la réconciliation vérifie que le conteneur est en cours d'exécution. Le heartbeat Paper renouvelle la présence des joueurs, mais aucune échéance de santé Paper n'est persistée pour l'instance. L'expiration des joueurs ne passe pas le serveur en échec.

**Conséquence :** une JVM dont le thread principal est bloqué peut rester `RUNNING`, occuper une place de capacité et conserver sa session. Un serveur vide bloqué peut encore être proposé au matchmaking.

**Solutions proposées :**

- Recommandation : persister une échéance de santé applicative et retirer progressivement du routage une instance dont Paper ne répond plus.
- Distinguer une partition du réseau de contrôle d'un blocage du jeu avec une sonde indépendante et un délai de confirmation avant redémarrage.

**Validation attendue :** conteneur actif avec heartbeat Paper interrompu, puis rétablissement avant ou après la période de grâce.

## 10. P2 — Un téléchargement de template peut rester bloqué sans échéance applicative

**Emplacement :** [appel HTTP sans signal d'annulation](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/agent/template-cache.ts:77).

**Constat statique :** ni le téléchargement ni l'extraction ne reçoivent de délai ou de signal d'annulation. Une opération suspendue reste dans la table `downloads`. Le délai du client orchestrateur ne s'applique pas à cette requête sortante de l'agent et ne met pas fin à son traitement.

**Conséquence :** si le flux distant ne se termine pas, les demandes de la même couche peuvent continuer à partager une opération bloquée. La reprise dépend alors du comportement réseau/runtime ou d'un redémarrage de l'agent.

**Solutions proposées :**

- Recommandation : imposer un délai total configurable et transmettre son signal au téléchargement et au pipeline d'extraction.
- Ajouter un délai sans progression, limiter les téléchargements concurrents et nettoyer les répertoires de préparation abandonnés au démarrage.

**Validation attendue :** serveur répondant aux en-têtes mais ne terminant jamais le corps, puis nouvelle demande de la même couche après expiration.

## 11. P2 — Paper peut remplacer une affectation récente par une réponse ancienne

**Emplacements :** [interrogation toutes les secondes](C:/Users/ninob/Documents/Code/EnderCloud/plugins/paper/src/main/java/fr/nayz/endercloud/paper/EnderCloudPaperPlugin.java:72), [remplacement inconditionnel de l'affectation](C:/Users/ninob/Documents/Code/EnderCloud/plugins/paper/src/main/java/fr/nayz/endercloud/paper/EnderCloudPaperPlugin.java:195).

**Constat statique :** les requêtes asynchrones d'affectation peuvent se chevaucher. Chaque réponse remplace `assignment` sans comparer la session et la révision actuelles. Le compteur d'acquittement utilise un maximum, mais le contenu de l'affectation peut quand même reculer.

**Conséquence :** un plugin de jeu peut lire une composition ancienne juste après en avoir reçu une nouvelle ; une ancienne réponse vide peut aussi effacer temporairement une affectation valide.

**Solutions proposées :**

- Correctif simple : une seule requête en vol, avec libération du verrou sur réussite et échec.
- Recommandation complémentaire : accepter les réponses selon un numéro de requête et comparer `(sessionId, revision)` pour empêcher toute régression.

**Validation attendue :** réponses aux requêtes N et N+1 livrées dans l'ordre inverse, y compris une réponse vide.

## 12. P2 — Des boucles en échec peuvent être déclarées réussies par la supervision

**Emplacements :** [erreurs des étapes absorbées](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/session-controller.ts:54), [succès annoncé au contrôleur d'incidents](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/scheduler.ts:31). Le même schéma existe dans les contrôleurs de capacité et de maintenance.

**Déclenchement :** chaque étape d'une boucle échoue, mais les erreurs sont journalisées et la méthode retourne normalement.

**Conséquence :** le scheduler appelle `recordLoopSuccess`, ce qui remet le suivi des erreurs à zéro et peut résoudre un incident de boucle. D'autres incidents métier peuvent exister, mais ils ne rendent pas ce signal de supervision correct.

**Preuve :** simulation du contrôleur de sessions avec ses six étapes en erreur : six erreurs journalisées, promesse finale résolue avec succès.

**Solutions proposées :**

- Recommandation : continuer les étapes indépendantes, collecter les erreurs et lever ensuite une `AggregateError`.
- Pour une supervision plus précise : retourner un résultat détaillé et suivre les échecs par groupe ou étape, sans effacer les échecs persistants avec un succès partiel.

**Validation attendue :** échec total et échec d'un seul groupe pendant plusieurs passages ; ouverture puis résolution correcte des incidents.

## 13. P2 — Un instantané Velocity peut écraser un événement Redis plus récent

**Emplacements :** [application d'un instantané](C:/Users/ninob/Documents/Code/EnderCloud/plugins/velocity/src/main/java/fr/nayz/endercloud/velocity/EnderCloudVelocityPlugin.java:276), [effacement du registre local](C:/Users/ninob/Documents/Code/EnderCloud/plugins/velocity/src/main/java/fr/nayz/endercloud/velocity/EnderCloudVelocityPlugin.java:297), [traitement des événements](C:/Users/ninob/Documents/Code/EnderCloud/plugins/velocity/src/main/java/fr/nayz/endercloud/velocity/EnderCloudVelocityPlugin.java:304).

**Constat statique :** le résultat HTTP remplace le registre pendant que Redis peut appliquer des modifications plus récentes. Certaines demandes de rechargement contournent également le drapeau `synchronizationInProgress`. Une collection concurrente protège les opérations individuelles, pas l'ordre logique entre instantanés et événements.

**Conséquence :** un serveur récemment enregistré peut disparaître localement, ou un serveur retiré réapparaître, jusqu'à une nouvelle convergence. Le rafraîchissement périodique limite souvent la durée sans supprimer la course.

**Solutions proposées :**

- Correctif ciblé : centraliser les rechargements, mettre les événements en tampon pendant la lecture de l'instantané et les rejouer après son application sur un même exécuteur.
- Solution plus robuste : fournir une version monotone de registre commune aux instantanés et aux événements et ignorer les écritures obsolètes.

**Validation attendue :** retarder une réponse d'instantané contenant l'ancien registre, appliquer un événement récent, puis livrer la réponse.

## 14. P2 — Une ancienne commande de transfert peut déplacer un joueur depuis le mauvais serveur

**Emplacements :** [source persistée dans la commande](C:/Users/ninob/Documents/Code/EnderCloud/orchestrator/src/services/hub-router.ts:206), [transfert sans contrôle de cette source](C:/Users/ninob/Documents/Code/EnderCloud/plugins/velocity/src/main/java/fr/nayz/endercloud/velocity/EnderCloudVelocityPlugin.java:401).

**Constat statique :** les transferts vers un hub contiennent `sourceInstanceId`. Velocity vérifie uniquement que le joueur n'est pas déjà sur la destination ; il ne vérifie pas sa présence sur la source attendue. La protection des transferts en cours porte sur `(commandId, playerId)` et ne protège pas des commandes distinctes qui se concurrencent.

**Conséquence :** avant l'expiration d'une commande en attente, un joueur peut changer de serveur ou commencer une autre activité, puis être ramené vers l'ancien hub au passage suivant de cette commande.

**Solutions proposées :**

- Recommandation : vérifier `sourceInstanceId` avant d'exécuter les commandes qui le précisent, puis enregistrer explicitement leur abandon si le joueur a changé de source.
- Ajouter une génération de transfert par joueur et une expiration transportée jusqu'au consommateur ; une commande récente invalide alors les anciennes.

**Validation attendue :** commander A vers B, déplacer le joueur de A vers C avant livraison, puis vérifier que la commande A vers B est abandonnée.

## Ordre de correction proposé

1. **Reprise des démarrages :** problèmes 1, 2 et 4. Ils peuvent bloquer toute une variante ou arrêter le contrôle central.
2. **Cohérence des instances et sessions :** problèmes 3, 5, 6, 7 et 8. Ils peuvent créer des ressources inattendues, laisser des sessions bloquées ou conserver des conteneurs actifs.
3. **Détection et délais :** problèmes 9, 10 et 12.
4. **Ordre des informations et transferts dans les plugins :** problèmes 11, 13 et 14.

Les corrections restent à choisir et à implémenter. Aucune des solutions proposées n'a été appliquée par cet audit.
