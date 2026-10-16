# Tester les proxys sur le cluster local

Le groupe `edge-proxies`, défini dans `groups/proxy.yml`, maintient deux instances
Velocity. Le template `templates/velocity-main/` contient le JAR Velocity fixé,
le plugin EnderCloud, la configuration et le secret de forwarding partagé avec
les templates Paper. Ne publiez pas ce secret.

## Connexion

Avec Minecraft Java compatible avec les hubs Paper, ajoutez ces deux serveurs :

| Depuis ce PC | Depuis le réseau local |
| --- | --- |
| `localhost:25565` | `192.168.1.23:25565` |
| `localhost:25566` | `192.168.1.23:25566` |

Velocity authentifie les comptes Minecraft (`online-mode = true`). Le plugin
choisit automatiquement un hub Paper parmi les backends disponibles. Les ports
peuvent changer après un remplacement : l'API expose les adresses actuelles.

Ouvrez le dashboard sur <http://localhost:3000> pour suivre les instances, les
joueurs et les admissions. En PowerShell :

```powershell
Invoke-RestMethod http://localhost:8080/api/v1/proxies |
  Format-Table endpoint, lifecycleState, ready, playerCount, acceptingConnections
```

Les deux proxys doivent être `RUNNING`, prêts et ouverts aux connexions. Leur
heartbeat est envoyé toutes les dix secondes. Le total global des joueurs du
dashboard compte les joueurs Paper ; chaque proxy affiche aussi son propre
compteur. Les proxys ne figurent pas dans `/api/v1/proxy/servers`.

## Tester le drain

Le cluster local possède un seul agent. Pour tester le drain sans déplacer les
hôtes, désactivez le groupe proxy :

1. Connectez un joueur à un proxy et gardez un second client disponible pour
   tenter une nouvelle connexion.
2. Passez `enabled: false` dans `groups/proxy.yml`, puis exécutez
   `docker compose restart orchestrator` depuis la racine du projet.
3. Vérifiez que l'API ferme immédiatement les admissions. Dans les dix secondes
   suivantes, les nouvelles connexions sont refusées par Velocity.
4. Le joueur déjà connecté doit rester sur son hub et pouvoir changer de backend.
   Après sa déconnexion, le proxy s'arrête lorsque le heartbeat confirme zéro
   joueur et le blocage des admissions. Le délai maximal est de quinze minutes.
5. Repassez `enabled: true`, puis redémarrez l'orchestrateur pour retrouver deux
   proxys. Relisez leurs endpoints dans l'API.

Cette opération draine les deux proxys ; les groupes Paper restent actifs.

## Relancer les services

```powershell
docker compose up -d --build orchestrator agent dashboard
```

Les paramètres proxy de `.env` activent explicitement les ports `25565–25574`
sur l'agent et annoncent l'adresse LAN `192.168.1.23`. Adaptez cette adresse si
elle change. Cette plage est distincte des ports Paper `25600–30000` et laisse
de la place aux remplacements temporaires.

Pour la configuration générale, consultez [les proxys gérés](PROXIES.md).
