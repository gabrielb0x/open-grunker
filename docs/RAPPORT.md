# Open Grunker — rapport d'avancement

*20 août 2026, mis à jour le 22 août · `/opt/open-grunker` · <https://grunker.g0x.dev>*

---

## En bref

Le jeu est **fonctionnel, déployé et joué**. Serveur autoritatif, client 3D
complet, comptes en base, API versionnée, nginx et systemd en place.
`npm test` passe **369/369**. Build courant : **v1.1.0**.

La grande réserve des deux premières passes est levée : **le client tourne
maintenant dans un vrai navigateur**, le tien. C'est d'ailleurs par là que le
premier bug de la v1.1.0 est remonté — la photo de clan qui ne s'affichait pas,
voir plus bas. Reste que rien n'est vérifié visuellement depuis cette machine :
aucun navigateur n'y est installé, donc le rendu, le pointer lock et l'audio
sont toujours validés par toi et pas par moi.

| | |
| --- | --- |
| Code écrit | ~28 900 lignes (hors three.js), dont 4 300 de tests |
| Dépendances runtime | 2 (`ws`, `three`) |
| Poids du client | 688 Ko + 2,1 Mo de three.js (132 Ko gzippé) |
| Charge serveur | 0,2 ms par tick, 7 salles × 60 Hz sur un Raspberry Pi 5 |
| Bande passante | ~9 Ko/s descendant par joueur |
| Tests | 369 vérifications, 10 suites, dont 3 qui démarrent un vrai serveur |

---

## Ce qui est fait

### Moteur partagé (`shared/`, 1 400 lignes)

Le même code s'exécute **octet pour octet** côté serveur et côté navigateur :
c'est ce qui rend la prédiction client exacte.

- **Mouvement** façon Quake/Source : friction au sol, accélération aérienne
  plafonnée (donc **air-strafe** et **bunny hop** réels — 9,2 u/s au sol,
  18 u/s atteints en enchaînant), **slide accroupi** avec boost, montée
  automatique des marches, coyote time, jump buffer, dégâts de chute.
- **Physique** : monde d'AABB avec grille de broad-phase, raycast par slabs.
- **Dispersion déterministe** : les deux côtés dérivent la direction de chaque
  plomb d'une graine `(joueurId, numéroDeTir)`. Le traceur affiché est
  exactement le rayon testé par le serveur — rien n'est confié au client.
- **9 classes** + arme de poing + couteau, modèles générés par recette de boîtes.
- **6 cartes** construites via un petit DSL (bâtiments avec portes, escaliers,
  conteneurs, caisses) : Burgtown, Sandstorm, Shipyard, Subzero, Crossfire et le
  stand de tir.

### Serveur (`server/`, 2 700 lignes)

- Salles autoritatives, simulation **60 Hz**, snapshots **30 Hz**, une seule
  boucle pour toutes les salles.
- **Compensation de lag** : rembobinage des hitboxes vers ce que le tireur
  voyait. Mesuré à 3–8 cm d'écart pour un ping de 20 à 150 ms, contre une
  demi-largeur de hitbox de 46 cm.
- Zones de dégâts (tête ×2,35, jambes ×0,85), atténuation à distance,
  fusil à pompe multi-plombs, roquettes avec dégâts de zone et **rocket jump**.
- Assists, séries de kills, killfeed, chat, tableau des scores, fin de match
  avec rotation de carte, persistance XP/GR.
- **IA de bots** : ils utilisent exactement le même pas de mouvement et le même
  chemin de tir que les humains — aucun raccourci serveur. 43 kills en 90 s à 8 bots.
- Filet de sécurité : un client qui cesse d'émettre est simulé au bout de 250 ms
  (il retombe au lieu de rester figé en l'air).

### Base de données (`server/db/`)

SQLite via `node:sqlite` intégré — aucun module natif à compiler, aucun
processus séparé. Dix-huit tables : comptes, stats, loadouts, sessions, matchs,
maîtrise d'arme, défis quotidiens, bannissements de compte / d'IP / de chat,
jetons d'e-mail, cache de réputation d'IP, signalements, clans, membres,
invitations, journal d'administration. Mots de passe en **scrypt asynchrone**
(55 ms, sans bloquer la boucle de jeu), jetons de session stockés hachés.
Les migrations sont idempotentes et rejouées à chaque démarrage.

### API REST `/api/v1`

39 endpoints publics : santé, méta, navigateur de serveurs,
inscription/connexion, vérification d'e-mail, profil, historique de matchs,
classement multi-tri, loadout, boutique de skins, photo de profil, signalements,
et les 14 routes de clans. Trente de plus pour l'administration, sur leur propre
port. Limitation de débit par IP, CORS restreint, erreurs JSON typées. `/api` et
une version inconnue renvoient un 404 qui nomme les versions supportées.

### Client (`client/`, 4 400 lignes)

- **Rendu** three.js : toute la carte en **un seul draw call** (InstancedMesh),
  ciel dégradé, ombres, brouillard.
- **Netcode** : prédiction à pas fixe + réconciliation. Erreur mesurée sur 750
  snapshots réels : **médiane 0,000 unité, p99 1 cm, aucune correction > 2 cm**.
- Interpolation des joueurs distants 100 ms en arrière.
- **Viewmodel** dans une scène à FOV séparé (l'arme ne gonfle pas en visée et ne
  traverse pas les murs) : balancement, recul à ressort, animation de recharge,
  akimbo, lunette.
- Effets : traceurs, impacts, sang, explosions, poussière — tout en pools.
- **Audio 100 % synthétisé** (WebAudio) : aucun fichier son.
- HUD complet : réticule dynamique, minimap orientée, killfeed, scoreboard,
  chat, nombres de dégâts, indicateurs directionnels, écran de mort.
- Menus : classes, serveurs, classement, clans, défis, skins, contrôles,
  réglages, aide, notes de version, compte.

### Infrastructure

- **nginx** `grunker.g0x.dev` : client servi en statique, `/api/` et `/ws`
  proxyfiés vers `127.0.0.1:7420`, gzip (three.js 650 Ko → 132 Ko), WebSocket
  maintenu 7 jours. Ports 8080/8081 évités comme demandé.
- **systemd** `open-grunker.service` en `www-data`, `ProtectSystem=strict`,
  écriture limitée à `data/`.
- Scripts : `setup.sh`, `deploy-nginx.sh`, `deploy-service.sh`, `db-cli.js`.
- **MOTD** enrichi : état du service, joueurs en ligne, salles, et disponibilité
  du site (sauvegarde dans `/etc/profile.d/motd.sh.bak-20260820`).

### Tests — `npm test`, 369/369

Dix suites. Trois d'entre elles démarrent le **vrai serveur** en processus fils
et le pilotent en HTTP et WebSocket : ce sont celles qui vérifient les règles
qu'une route applique réellement, pas celles qu'une fonction prétend appliquer.

| Suite | Ce qu'elle prouve |
| --- | --- |
| `movement` | 88/88 spawns valides, 891/891 points de chute stabilisés, air-strafe, slide, escaliers, contacts à fleur |
| `combat` | Zones de dégâts, atténuation, pompe, sniper, roquette, rembobinage, murs bloquants |
| `lagcomp` | 71/71 tirs au but sur cible en strafe, à 20 / 60 / 150 ms de ping |
| `simulation` | Match de bots complet, rotation de carte, tableau de fin, système de points, conservation du score, équilibrage TDM |
| `keybinds` | Défauts sans collision, vol de touche au rebind, souris/molette, `ESC` réservée, persistance |
| `modes` | Gun game, domination, stand de tir, vote de carte |
| `moderation` | Règlement de fin de partie, bans, mutes, les six plafonds de signalement, sniffage d'images |
| `accounts` | *(vrai serveur)* captcha, lien de confirmation, refus VPN, renommage payant, une seule session, chiffres réservés au staff |
| `clans` | *(vrai serveur)* règles de tag, niveaux, GR, invitations, transfert, photo de clan, migration d'une base antérieure aux clans |
| `client` | *(navigateur simulé)* le HUD, les menus, le rendu, la balistique — sur le vrai `index.html` |

---

## Ce qui reste

### À faire en priorité

1. **Un navigateur sur cette machine.** Le jeu tourne chez toi, donc le rendu,
   le pointer lock et l'audio sont exercés — mais je ne les vois toujours pas.
   `sudo apt install chromium` sur le Pi me permettrait de vérifier une mise en
   page moi-même au lieu de te la faire décrire.

2. **Équilibrage.** Les chiffres d'armes sont posés à la main et jamais
   confrontés à de vrais joueurs. À réajuster après quelques parties.

3. **Vérifier les premiers clans.** `[DEV]` existe déjà en base ; le tag est
   dans la liste réservée, donc il a été créé avant qu'elle n'atterrisse ou à la
   main. Rien de cassé — la réserve ne bloque que la création — mais c'est le
   genre de détail à regarder avant d'en ouvrir la porte à tout le monde.

### À peaufiner

- **Anti-triche** : le serveur fait autorité sur la position, les dégâts et les
  munitions, et la dispersion est déterministe. En revanche il fait confiance à
  l'angle de visée envoyé par le client (comme Krunker) : le recul est
  client-side, donc un client modifié peut l'annuler. À ajouter si besoin :
  contrôles de plausibilité (vitesse angulaire, snap d'aim) et bannissement.
- **Protocole binaire** : le JSON coûte ~9 Ko/s par joueur. Un encodage binaire
  diviserait ça par 3–4. Inutile à 8 joueurs, utile au-delà.
- **Modes supplémentaires** : FFA, TDM, gun game, domination et stand de tir
  existent. Capture de drapeau et parkour sont dans l'esprit Krunker et manquent.
- **Mobile** : aucune commande tactile, le jeu est clavier/souris uniquement.
- **Skins** : simples teintes, et `unlockLevel` est à 0 partout — aucun
  déblocage par niveau n'est réellement appliqué.
- **Certificat** : le self-signed partagé convient en mode Cloudflare *Full*,
  mais pas en *Full (Strict)*.
- **Classement des clans** : rangé sur la somme des scores des membres, calculée
  à la volée. Correct à cette échelle, à mettre en cache si les clans se
  multiplient.
- **Ragdolls / animations de mort** : les corps disparaissent simplement.

---

## Commandes utiles

```bash
# État
sudo systemctl status open-grunker
journalctl -u open-grunker -f
curl -s localhost:7420/api/v1/health           # build + uptime, publics

# Déployer une modification du code
sudo systemctl restart open-grunker            # coupe les parties en cours
sudo bash scripts/deploy-nginx.sh              # seulement si le vhost a changé

# Tests
npm test
npm test clans                                 # une seule suite

# Base
node scripts/db-cli.js stats
node scripts/db-cli.js users
node scripts/db-cli.js admin <pseudo>          # donne le rôle admin

# Panneau d'administration (réseau local uniquement)
xdg-open http://127.0.0.1:7421/admin

# Vérifier le site sans passer par le DNS
curl -sk --resolve grunker.g0x.dev:443:127.0.0.1 https://grunker.g0x.dev/api/v1/health
```

> Un serveur de test se lance sur un autre port, jamais sur 7420 :
> `PORT=7499 DB_PATH=/tmp/t.db npm start`. Et surtout pas de
> `pkill -f server/index.js` — le motif attrape aussi le serveur en production.


---

## Mise à jour du 21 août 2026

Deuxième passe, sur demande. `npm test` passe **71/71**.

### Bugs corrigés

- **Téléportation en haut des arbres et des murs.** La résolution de collision
  recalait le corps sur la face *opposée* de la boîte la plus profondément
  pénétrée. Quand le contact était pile à fleur, l'arrondi flottant créait un
  chevauchement d'un cheveu et le pas de gravité suivant envoyait le joueur au
  sommet du sapin. Le déplacement est désormais borné à l'intervalle balayé (on
  ne peut jamais reculer plus loin que le point de départ), avec une marge de
  peau de 0,1 mm, un dépénétrateur MTV pour les cas d'écrasement, et un pas
  d'escalier qui refuse toute position finale en intersection. Test de
  non-régression : `movement` — 12 contacts à fleur, 1 440 approches d'obstacle.
- **`Tab` sortait du jeu.** Le `preventDefault` arrivait après un `return`
  anticipé sur les répétitions clavier : maintenir `Tab` laissait donc passer
  la navigation au clavier du navigateur. La touche est désormais neutralisée
  avant toute sortie de fonction, au `keydown` comme au `keyup`.
- **Bouton « changer de classe » inopérant.** Le modal vivait à l'intérieur de
  `#menu`, masqué en partie. Il est sorti au niveau racine, et le serveur
  applique le changement **immédiatement** hors combat (4 s sans dégâts donnés
  ni reçus) au lieu de toujours attendre la réapparition.
- **Score remis à zéro.** Le score est conservé au changement de classe, et
  parqué à la déconnexion : revenir dans la même salle avant la fin du match
  restitue la fiche complète. Ouvrir les réglages en partie n'entraîne plus de
  déconnexion — le menu s'affiche par-dessus la partie.

### Ajouts

- **Monnaie GR** partout (migration SQLite `users.kr → users.gr` automatique au
  démarrage, idempotente).
- **Système de points** : 50 par kill, +50 headshot, +25 midair, +50 drift,
  +100 no-scope, longshot, backstab, multi-kill, série, assist, first blood,
  revanche, shutdown, malus suicide/tir allié. **100 points = 1 GR** en fin de
  partie. Scoreboard en direct en haut à droite, pop-ups de points au centre.
- **Parties de 4 minutes, 8 joueurs**, intermission de 18 s pendant laquelle le
  tableau complet de la partie reste affiché (score, GR, K/D/A, headshots,
  dégâts, précision, meilleure série).
- **Munitions illimitées** sur toutes les armes (`reserve: -1` sur le fil).
- **Bunny hop assisté** : friction ignorée au tick du saut enchaîné, friction
  adoucie 180 ms après l'atterrissage, buffer de saut 220 ms, coyote 160 ms.
- **Touches configurables** : deux emplacements par action, clavier, boutons de
  souris et molette, onglet CONTROLS, synchronisées sur le compte.
- **Plus de wallhack gratuit** : les plaques de nom et la minimap ne montrent
  un ennemi que s'il est réellement en vue (test de ligne de mire trois fois par
  seconde, mémoire d'une seconde sur la minimap).
- **Vrai menu de compte** : avatar, badge vérifié, barre d'XP, solde GR, douze
  statistiques, historique des matchs, changement de mot de passe, déconnexion.
- **Panneau d'administration** sur son propre port (7421), accessible depuis la
  machine *et* depuis le réseau local. Onglets Joueurs et Logs. Édition des
  comptes (pseudo, e-mail, clan, rôle, badge vérifié, GR, niveau, XP, stats),
  bannissements, reset de mot de passe, expulsion, suppression. Journal serveur
  filtrable et piste d'audit de chaque action.
- **Graphismes** : tone mapping ACES, ombrage par face cuit dans les sommets du
  cube instancié, ciel avec disque solaire et nuages, sol procédural détaillé,
  lumière de complément, ombres resserrées autour du joueur, personnages plus
  détaillés (gilet, sac, visière, épaulières, bottes, ombre de contact),
  flashs de bouche éclairants, secousses de caméra, vignette, minimap ronde.

### Troisième passe — accueil et parties partageables

- **Connexion automatique à l'arrivée.** Ouvrir le site ouvre une socket en
  mode **spectateur** : le client entre dans une vraie partie sans y prendre
  part. Il n'apparaît sur aucun écran, ne peut ni tirer ni écrire, et n'occupe
  aucune des huit places. Le menu n'est plus une page mais un voile posé sur le
  jeu en cours — le fond, c'est la partie, filmée par une caméra qui orbite
  lentement au-dessus du centre de la carte.
- **PLAY prend un siège sur place** : un seul message `pl`, pas de reconnexion,
  pas d'écran de chargement. Le serveur asseoit le spectateur, restaure sa fiche
  de score s'il en avait une, et annonce son arrivée aux autres.
- **Codes de partie partageables.** Chaque salle porte un code
  `<RÉGION>:<4 caractères>` dérivé de son identifiant (donc stable au
  redémarrage). L'URL suit la partie en cours — `grunker.g0x.dev/?game=FRA:7K2Q`
  — et ouvrir ce lien fait atterrir dans la même salle. Une salle pleine reste
  regardable ; seul le siège demande de la place.
- **Cache client corrigé.** nginx gardait les `.js` 24 h sans revalider : un
  joueur pouvait rester bloqué une journée sur un ancien build (c'est ce qui
  cachait le badge vérifié dans le classement, déjà présent dans le code).
  Le code passe maintenant en `no-cache` — il revalide, il ne re-télécharge pas.

### Réserve inchangée

Le client n'a toujours pas tourné dans un vrai navigateur : aucun n'est
installé ici. Tout est vérifié syntaxiquement, le graphe d'imports et chaque
identifiant DOM référencé sont contrôlés automatiquement, et le protocole a été
rejoué de bout en bout sous Node contre le vrai serveur — mais le rendu WebGL,
le pointer lock et l'audio restent à valider dans un navigateur.

Note anti-triche : la visibilité des plaques de nom est calculée **côté
client**. Le serveur continue d'envoyer la position de tous les joueurs dans
les snapshots (il n'y a pas de PVS serveur), donc un client modifié pourrait
toujours les afficher. Le but demandé — que le jeu n'offre pas de wallhack
gratuit — est atteint ; un vrai filtrage serveur serait le cran suivant.

---

## Mise à jour du 22 août 2026 — v1.1.0

Quatrième passe. `npm test` passe **369/369** (contre 295 avant). Trois suites
démarrent désormais un vrai serveur et le pilotent en HTTP.

### Le bug qui rendait le scoreboard inutilisable

Aucun bouton du tableau des scores n'a **jamais** fonctionné. La feuille de style
posait `#hud * { pointer-events: none }` — pour que le HUD ne mange pas les
clics destinés au jeu — avec une liste d'exceptions qui ne contenait que le
champ de chat et la carte de fin de match. Le scoreboard n'y était pas : mute,
unmute et signalement étaient dessinés, survolés, et morts au clic.

Le tableau est maintenant dans la liste d'exceptions, et il **reste ouvert avec
la souris rendue** au lieu de ne s'afficher que touche maintenue. C'était déjà le
cas pour le staff et pour quiconque pouvait signaler ; ça l'est pour tout le
monde, parce qu'il n'existe plus de version du tableau qui ne soit qu'à lire.

Un test vérifie que la règle d'exception contient bien le scoreboard, pour que
la prochaine réécriture du CSS ne le redécouvre pas en production.

### Signalements : six plafonds au lieu de trois

Un signalement ne coûte rien à celui qui l'écrit et coûte une minute de lecture
à un modérateur. La seule chose qui garde la file lisible, c'est qu'aucun compte
ne puisse la remplir. Chaque plafond répond à une manière différente d'abuser du
bouton, et tous sont appliqués par le serveur au moment du dépôt :

| Règle | Défaut | Pourquoi |
| --- | --- | --- |
| Niveau minimum | 2 | Un compte jetable n'est pas un témoin |
| 60 s entre deux signalements | `REPORTS_COOLDOWN_SEC` | Un incident à la fois, pas une rafale |
| 6 par heure | `REPORTS_MAX_PER_HOUR` | Une mauvaise soirée n'enterre pas une semaine de vrais signalements |
| 15 par jour | `REPORTS_MAX_PER_DAY` | …et le plafond horaire ne s'attend pas six fois de suite |
| 5 encore ouverts | `REPORTS_MAX_OPEN` | Ce qu'un modérateur n'a pas lu n'est pas un quota à dépenser |
| 10 min sur la même cible | `REPORTS_REPEAT_COOLDOWN_SEC` | Un incident, une entrée dans la file |
| 5 rejets en 7 jours → 24 h bloqué | `REPORTS_DISMISSED_*` | Crier au loup coûte la journée suivante |

Aucun n'est une punition : tous se lèvent seuls, et celui qui mord le plus fort —
les signalements ouverts — est rendu dès qu'un humain travaille la file.
Signaler de vrais tricheurs rend le quota dans l'heure ; signaler tout le monde
l'épuise avant midi. Le verrou « crier au loup » se compte depuis le dernier
rejet plutôt que d'être stocké, donc il expire sans rien à nettoyer.
**ACCOUNT ▸ REPORTS** montre où en est le compte face à chacun d'eux.

### Clans

Un clan, c'est un **tag de deux à quatre caractères** dessiné devant le pseudo
partout où un pseudo apparaît — tableau des scores, chat, killfeed, classement,
plaques de nom en jeu, écran de mort, carte de MVP. **Gris**, et **doré** une
fois le clan vérifié par les développeurs depuis le panneau d'administration.
Cette couleur est tout ce que la vérification achète, ce qui est précisément
pourquoi elle peut se donner au jugé.

| | Condition |
| --- | --- |
| Rejoindre | niveau **5** |
| Fonder | niveau **15** et **1000 GR** |
| Tag | 2–4 caractères, `A–Z` et `0–9` uniquement, unique, non réservé |
| Membres | 24 |

**Les règles de tag sont volontairement étroites.** Un tag capable de contenir
un liant sans chasse, une marque de droite-à-gauche, un accent combinant ou un
crochet est un tag capable d'usurper un modérateur, de casser une ligne de
killfeed ou de déborder sur la plaque d'à côté — et un tableau des scores n'a
aucun moyen de distinguer ça d'un nom de clan. Le tag est donc de l'ASCII
majuscule et rien d'autre, avec une liste réservée (`MOD`, `DEV`, `ADMN`,
`STAF`…) pour qu'aucun tag ne puisse se lire comme une parole du serveur. La
suite de tests essaie les dix formes d'attaque et vérifie qu'elles sont toutes
refusées.

**Sur invitation uniquement** : il n'y a pas de « demande à rejoindre », donc un
clan ne vous arrive jamais dessus et le propriétaire est la seule porte. Il
invite, retire, **transmet le clan** (en restant membre), pose une **photo de
clan** et dissout. Il ne peut pas simplement partir : un clan sans personne qui
puisse inviter, retirer ou dissoudre est un clan que plus personne ne répare. Et
si son compte est supprimé, le clan revient au membre le plus ancien.

Un joueur est dans **un** clan — garanti par un index unique, pas par un test,
donc deux invitations acceptées dans la même seconde ne peuvent pas gagner
toutes les deux. Les changements atteignent une partie en cours : rejoindre,
partir, être retiré ou voir le clan vérifié re-badge chaque connexion vivante
sans reconnexion.

Le tag est **dénormalisé** sur la ligne du compte (`users.clan`,
`users.clan_verified`) : le classement, la poignée de main de connexion et
chaque plaque de nom lisent une colonne au lieu de faire une jointure. Une seule
fonction a le droit d'y écrire, `db.clans.syncMembers()`, donc « le cache est
périmé » n'a qu'un seul endroit où aller regarder.

### Cliquer sur un pseudo

**Chaque pseudo du jeu ouvre le profil de ce joueur** — tableau des scores, chat,
carte de fin de match, classement, effectif d'un clan. La même carte partout :
photo, niveau, tag de clan, statistiques et derniers matchs. Les invités et les
bots n'ont rien derrière eux, donc pas de lien qui ne pourrait que échouer.

Un seul écouteur délégué sur le document plutôt qu'un par ligne dessinée : le
tableau, le chat et le classement se redessinent en permanence, et un écouteur
qu'il faut ré-attacher après chaque redessin est un lien qui cesse de marcher la
première fois qu'on l'oublie.

### Le menu

- **Le champ pseudo et la ligne « signed in as… » sont partis.** Tous deux
  répétaient ce que la pastille de compte en haut à gauche dit déjà — le nom, le
  niveau, les GR, l'entrée et la sortie d'un compte. La place va maintenant à la
  seule chose que rien n'indiquait : **le build et ses notes de version**, avec
  l'historique complet derrière un onglet.
- **Les chiffres en direct** (comptes, matchs joués, joueurs en ligne) sont
  **réservés au staff**. Pas seulement masqués : `/api/v1/stats/global` répond
  403 à qui n'est pas modérateur, et `/api/v1/health` ne livre plus l'intérieur
  des salles. Au passage, cette route publiait le **chemin du fichier de base de
  données** à qui la demandait ; ce n'est plus le cas. `/servers` reste public,
  parce que le navigateur de serveurs ne peut pas choisir une partie sans lui.

### Panneau d'administration

Un onglet **CLANS** à part entière : la liste avec propriétaire, effectif et
score, et le détail avec l'effectif, les invitations en attente, le bouton de
**vérification** (le tag doré), le retrait de la photo et la dissolution. Le
compteur de clans est dans la barre du haut ; on saute d'un joueur à son clan et
d'un effectif à un joueur d'un clic. Le champ « clan » de la fiche joueur n'est
plus du texte libre — c'est une ligne d'appartenance — et ne propose plus que de
sortir le compte de son clan.

### Deux bugs de déploiement attrapés avant toi, un après

- **Le serveur n'aurait pas redémarré.** `schema.sql` s'exécute *avant* les
  migrations. L'index que les clans ajoutent sur `users.clan_id` s'y trouvait, et
  sur une base antérieure aux clans il référence une colonne qui n'existe pas
  encore : `SQL logic error` à l'import du module, avant qu'une seule route
  n'existe. Vérifié sur une copie de ta sauvegarde `.bak` (antérieure même à
  `gr`). Corrigé, plus un second cas de colonne ajoutée deux fois, et une suite
  de tests ouvre maintenant une base d'avant les clans à chaque `npm test`.
- **La photo de clan ne s'affichait pas** — celle que tu as signalée. L'envoi
  marchait : le fichier était bien sur le disque et en base. C'est nginx qui ne
  connaissait pas le préfixe `/clan-avatars/`, donc la requête tombait dans la
  règle générique des images et cherchait le fichier sous la racine du client :
  404. Les photos de clan sont maintenant servies sous **`/avatars/clans/`**, un
  sous-chemin du préfixe déjà proxyfié — et comme ce bloc nginx est en `^~`,
  nginx s'arrête avant ses règles d'expression régulière et tout ce qui est
  dessous arrive au serveur. **Aucune modification de nginx n'est nécessaire**,
  ni maintenant ni pour le prochain type de contenu qu'on y mettra. Un test
  vérifie que l'URL reste sous `/avatars/`.

### Divers

- `PROTOCOL_VERSION` passe à **6** : une page déjà ouverte se fait dire de
  recharger plutôt que de dessiner à moitié un jeu qu'elle ne connaît plus.
- Le simulateur de navigateur des tests sait maintenant faire **remonter les
  événements** et répondre à `closest()`. Sans ça, les écouteurs délégués — donc
  tous les pseudos cliquables — auraient été testés à vide.
- `shared/patchnotes.js` : le numéro de build et les notes vivent au même endroit
  pour le serveur et le navigateur, donc le menu, l'API et le README ne peuvent
  pas se contredire.
