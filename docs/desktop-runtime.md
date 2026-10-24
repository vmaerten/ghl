# Runtime desktop : Wails v2, Wails v3 ou Electron

Statut : comparatif du 24 octobre 2026, avant de choisir le runtime qui succède à Wails v2.16. « Vérifié » signifie lu dans le code source, la documentation de la version citée ou des données de release ; le reste est marqué « non vérifié ».

## Résumé

Recommandation : **Wails v3**, en figeant une beta. Il lève les limites qui nous ont arrêtés en v2 (barre compacte, plusieurs fenêtres et onglets natifs, menus contextuels natifs) et garde un seul processus Go et une archive de 7,5 Mio. Le portage sur `main` est fait (branche `feat/wails-v3`), et les mesures du 24 octobre le donnent au moins aussi bon que v2 partout.

Electron ferait mieux sur quatre points : même moteur en production que dans les tests (Chromium), placement libre des boutons de fenêtre, translucidité qui suit le focus, apparence changeable à chaud. Mesuré sur ghl, il démarre et change d'onglet 14 à 92 ms plus vite, rouvre une review depuis le terminal 60 ms plus lentement, et occupe 70 à 140 Mio de plus au repos. Il coûte une archive 16 fois plus lourde (119 Mio contre 7,5), un processus principal en JavaScript à côté du serveur Go, une réécriture des menus, du packaging et du smoke natif, et une montée de version majeure tous les six mois au plus tard. Il n'apporte rien sur la signature ni les mises à jour automatiques, qui exigent un Developer ID dans les trois cas.

Electron deviendrait le bon choix si les écarts entre WebKit et Chromium se mettaient à coûter régulièrement, ou si ghl visait Windows et Linux avec un rendu identique partout.

## Ce dont ghl a besoin

- Un seul binaire `ghl` : la CLI (`ghl`, `ghl comments`) et l'app, qui reçoit les ouvertures par un socket Unix (`desktop/instance.go`).
- Le serveur de review Go (`go/internal/app`), aujourd'hui dans le même processus que la fenêtre.
- Une barre de titre unifiée avec la capsule de comparaison, des menus natifs avec raccourcis, la translucidité de la fenêtre, l'apparence claire ou sombre choisie dans Settings, un dialogue d'ouverture de dossier, le presse-papiers, la fenêtre ouverte agrandie.
- Bientôt peut-être : une barre plus basse (maquettes de [desktop-titlebar-mockup.html](./desktop-titlebar-mockup.html)), plusieurs fenêtres regroupées en onglets macOS, des menus contextuels sur les fichiers.
- Distribution : zip sur GitHub, cask Homebrew et mise, signature ad hoc, macOS 13 ou plus sur Apple Silicon.
- Tests : l'interface tourne dans Chrome headless avec des bindings simulés ; le smoke natif pilote la vraie fenêtre WebKit.

## Maturité

| | Wails v2 | Wails v3 | Electron |
| --- | --- | --- | --- |
| Version | 2.17.0, stable (18 octobre 2026) | 3.0.0-beta.34 (20 octobre 2026) | 45.0.0, stable (20 octobre 2026) |
| Rythme | Correctifs | Beta automatique de nuit, plusieurs par semaine | Une majeure toutes les 8 semaines |
| Support | Maintenu tant que v3 n'est pas sortie | API annoncée stable ; jalon « v3.0.0 GA » à 92 tickets fermés et 7 ouverts, échéance du 15 septembre dépassée, sans date | Les 3 dernières majeures, soit environ 6 mois chacune |
| macOS minimum | Ne limite pas ghl, compilé pour 13 | À vérifier | 13 depuis Electron 44 ; monte avec Chromium |

Des 7 tickets ouverts pour la 3.0, un seul touche macOS : préparer la couche AppKit pour macOS 27 ([#5760](https://github.com/wailsapp/wails/issues/5760)). Les autres visent Windows, Linux ou l'outillage. La beta.34 demande Go 1.26 ; `desktop/go.mod` est en 1.25.

## Architecture

- **Wails v2 et v3** : un processus Go tient la fenêtre et le serveur. Les menus, l'instance unique et les dialogues restent en Go ; le WKWebView et ses processus XPC appartiennent à macOS.
- **Electron** : un processus principal Node (menus, fenêtres, dialogues, IPC), un rendu Chromium, et le serveur Go lancé à côté par `child_process.spawn` (`utilityProcess` ne lance que du JavaScript, vérifié). La page charge le serveur en loopback, directement ou par `protocol.handle` qui relaie vers lui (motif de la documentation, vérifié). Il faut lire le port au démarrage du serveur, l'arrêter avec l'app et le faire quitter si Electron meurt (conception, non vérifiée).
- **CLI avec Electron** : `ghl` doit rester le binaire Go dans `Contents/MacOS`, puisque mise met ce dossier dans le `PATH` ; l'exécutable Electron prend un autre nom (non vérifié avec Forge ou electron-builder). Le socket d'instance passe au serveur Go, qui doit alors demander à Electron d'ouvrir la review : un aller-retour de plus. codiff fait l'inverse : sa CLI shell lance `open -n Codiff.app --args …`.

## Fonctions natives

| Besoin | Wails v2 | Wails v3 (beta.34) | Electron 45 |
| --- | --- | --- | --- |
| Barre de titre plus basse que 52 px | Non : 52 px avec barre d'outils, 28 px sans (vérifié) | Barre compacte de 38 px (`MacToolbarStyleUnifiedCompact`, vérifié) ; pas d'API pour placer les boutons de fenêtre | Hauteur libre : barre en HTML, boutons placés par `trafficLightPosition` (vérifié ; codiff : 40 px) ; pas de `NSToolbar` |
| Translucidité qui grise quand la fenêtre perd le focus | Non, toujours active (vérifié) | Non avec `MacBackdropTranslucent`, toujours active (vérifié) ; oui avec Liquid Glass | Oui, `visualEffectState: 'followWindow'` (vérifié) ; codiff passe la fenêtre en `transparent`, ce qui retire l'ombre native |
| Apparence claire ou sombre forcée | Non, fonctions vides sur macOS (vérifié) | Par fenêtre à sa création (vérifié) ; pas d'API trouvée pour la changer à chaud | Pour toute l'app, à chaud (`nativeTheme.themeSource`, vérifié) |
| Menus avec raccourcis | Oui ; menu de l'app figé, Settings dans File (vérifié) | Oui ; menu de l'app à vérifier | Oui, menu de l'app libre (vérifié) |
| Menus contextuels natifs | Non (vérifié) | Oui (vérifié) | Oui, `Menu.popup` (vérifié) |
| Plusieurs fenêtres, onglets macOS | Non (vérifié) | Oui, `TabbingMode` (vérifié) | Oui, `tabbingIdentifier` et `addTabbedWindow` (vérifié) ; le regroupement se fait dans le code, pas tout seul |
| Instance unique avec arguments et dossier courant | Partielle : socket maison (`instance.go`) | Intégrée, avec `WorkingDir` (vérifié) ; le socket maison peut rester | `requestSingleInstanceLock` et `second-instance` (vérifié) |
| Fenêtre agrandie, dialogues, presse-papiers | Oui | Oui (vérifié) | Oui (vérifié) |

## Moteur web

Wails affiche la page dans le WKWebView du système : la version de WebKit suit celle de macOS, donc un utilisateur sous macOS 13 a un moteur plus ancien que sous macOS 26. Les tests, eux, tournent dans Chrome headless. Le journal de [desktop-redesign.md](./desktop-redesign.md) relève déjà des écarts propres à WebKit (`overflow: clip` à partir de WebKit 16, sélection de texte dans la barre de titre, menu contextuel par défaut).

Electron embarque son Chromium (M156 pour Electron 45) : le même moteur partout, celui des tests, et les DevTools de Chrome. C'est son argument le plus solide pour ghl.

## Mesures

Banc du 24 octobre 2026 sur un Apple M5 Pro sous macOS 26.6.2. Les trois apps sont construites depuis `main` (`c530c67`) avec la même interface : Wails v2, Wails v3 (portage de la branche `feat/wails-v3`) et un prototype Electron 45 (branche `spike/electron`) qui lance le serveur Go à côté. Chaque essai démarre l'app sur un dépôt de test, ouvre un second dépôt en onglet, change 30 fois d'onglet dans l'interface, puis rouvre 10 fois une review depuis le terminal. Deux charges : 1 fichier et 2 lignes changées, puis 40 fichiers et 2 000 lignes changées. 4 séries, en alternant l'ordre des runtimes. La mémoire est l'empreinte physique de l'app, de ses processus fils (aides Electron, serveur Go) et des processus WebKit qui lui sont rattachés. Les chiffres sont des médianes, avec l'écart minimum–maximum des 4 séries.

| | Wails v2 | Wails v3 | Electron 45 |
| --- | --- | --- | --- |
| Archive zip | 7,3 Mio | 7,5 Mio | 119 Mio |
| App installée | 23 Mio | 24 Mio | 269 Mio |
| Processus | `ghl`, 3 processus WebKit, 1 aide audio | Idem | Principal, 3 aides, serveur Go |

Petit diff :

| Mesure | Wails v2 | Wails v3 | Electron 45 |
| --- | --- | --- | --- |
| Démarrage jusqu'au premier diff | 874 ms (831–884) | 894 ms (793–942) | 802 ms (735–962) |
| Mémoire, deux reviews ouvertes | 194 Mio (190–195) | 178 Mio (176–179) | 249 Mio (247–251) |
| Mémoire après 30 changements d'onglet | 220 Mio (209–224) | 202 Mio (198–204) | 298 Mio (296–300) |
| Mémoire en fin d'essai | 228 Mio (215–231) | 211 Mio (207–213) | 302 Mio (300–303) |
| Changement d'onglet | 164 ms (156–169) | 154 ms (151–160) | 140 ms (135–151) |
| Ouverture depuis le terminal | 356 ms (345–365) | 338 ms (329–366) | 400 ms (383–420) |

Gros diff :

| Mesure | Wails v2 | Wails v3 | Electron 45 |
| --- | --- | --- | --- |
| Démarrage jusqu'au premier diff | 969 ms (952–1 092) | 949 ms (899–990) | 884 ms (865–915) |
| Mémoire, deux reviews ouvertes | 271 Mio (268–275) | 225 Mio (219–234) | 363 Mio (353–366) |
| Mémoire après 30 changements d'onglet | 390 Mio (384–400) | 391 Mio (334–458) | 430 Mio (414–435) |
| Mémoire en fin d'essai | 437 Mio (421–453) | 435 Mio (377–493) | 428 Mio (419–434) |
| Changement d'onglet | 204 ms (199–212) | 194 ms (186–204) | 165 ms (162–181) |
| Ouverture depuis le terminal | 417 ms (411–435) | 393 ms (384–436) | 451 ms (440–494) |

Ce qu'on en retient :

- **Wails v3 fait au moins aussi bien que v2** : 16 à 46 Mio de moins avec deux reviews ouvertes, des changements d'onglet un peu plus rapides. L'ancien portage (branche `desktop/wails-v3`, avant la refonte) ouvrait une review depuis le terminal environ 400 ms plus lentement ; ce ralentissement venait de l'instance unique de Wails v3, que `main` remplace par son propre socket, et il a disparu. Sur le gros diff, la mémoire de v3 après usage varie beaucoup d'une série à l'autre, sans dépasser v2 en médiane.
- **Electron part de plus haut en mémoire** : 71 Mio de plus que v3 avec deux petites reviews, 138 Mio avec deux grosses. L'écart se referme avec l'usage, parce que la mémoire de WebKit croît à chaque changement de review quand celle d'Electron reste stable : en fin d'essai sur le gros diff, les trois se valent.
- **Electron gagne un peu en vitesse d'affichage** : un changement d'onglet 10 à 15 % plus rapide, un démarrage plus court de 65 à 92 ms, avec un cache Chromium déjà chaud. Il rouvre une review depuis le terminal 60 ms plus lentement, parce que le prototype lance un second processus Electron pour passer le relais ; une CLI Go qui parlerait au serveur supprimerait sans doute cet écart (non mesuré).
- Les écarts de temps restent entre 14 et 92 ms. Les écarts nets sont la taille, 16 fois plus lourde, et la mémoire au repos.

Ces mesures remplacent les benchmarks publics, qui se contredisaient : celui d'Elanis donnait Electron 3,6 fois plus gourmand en ignorant les processus WebKit, [tauri#5889](https://github.com/tauri-apps/tauri/issues/5889) le donnait plus léger que WKWebView.

## Distribution et mises à jour

Les trois options restent en signature ad hoc sans Developer ID, avec le même passage par Gatekeeper : le cask retire la quarantaine, et sous macOS 15 l'utilisateur d'un zip téléchargé passe par Réglages Système. Electron demande de re-signer tout le bundle (quatre apps d'aide, le framework, Squirrel, le binaire Go) ; electron-builder sait signer en ad hoc (`identity: "-"`, vérifié). codiff, lui, signe avec un Developer ID et notarise (vérifié).

Aucune des trois options ne permet une mise à jour automatique sans Developer ID : Squirrel.Mac compare la signature de la mise à jour à celle de l'app, et une signature ad hoc ne vaut que pour un binaire précis (vérifié dans le source, non testé de bout en bout). Restent `brew upgrade --cask`, `mise up`, ou un avis de mise à jour dans l'app.

## Coût du changement

**Wails v3.** Le portage tient en deux commits sur la branche `feat/wails-v3` : les services, la fenêtre, les menus, les dialogues et les événements de v3 dans `main.go` et `launch.go`, et un module `native.js` qui reconstruit l'interface que la page attend à partir du runtime v3, sans toucher à l'interface React. Il a révélé un trou : la page v3 a pour origine `wails://localhost`, que le serveur de review acceptait comme `localhost` ; il n'accepte plus que `http` et `https`. Les tests Go passent et le banc l'a fait tourner 8 fois sans erreur. Restent le smoke natif, la documentation et le passage à Go 1.26 (`desktop/go.mod`).

**Electron.** Le prototype de la branche `spike/electron` (serveur Go à côté, onglets, instance unique, une partie des menus) tient en deux fichiers JavaScript (510 lignes) et un `main` Go d'une cinquantaine de lignes, mais l'app complète demande plus. Tout le code natif passe en JavaScript : processus principal, les 26 entrées de menu, dialogues, instance unique, lancement et arrêt du serveur Go. Puis le packaging (Forge ou electron-builder, signature ad hoc, binaire Go dans le bundle), la release (GoReleaser ne suffit plus), `bridge.js` et `simulator.ts` réécrits autour de l'IPC, et le smoke natif refait, mais pilotable avec Puppeteer comme le reste des tests. Node entre dans la chaîne de build de l'app. Estimation : plusieurs PRs, puis une montée de majeure Electron au moins tous les six mois.

## Ce que les mesures ne couvrent pas

- Un seul Mac, sous macOS 26.6.2 : macOS 13, dont le WebKit est plus ancien, n'a pas été mesuré.
- Le prototype Electron ne porte qu'une partie des menus et rien de Reveal in Finder ; une vraie app Electron aurait plus de code dans son processus principal.
- Les longues sessions : la mémoire de WebKit croît à chaque changement de review, sur une durée bien plus longue que 40 changements.
- Le smoke natif n'a pas encore tourné sur le portage v3.

## Sources

- Wails : [releases](https://github.com/wailsapp/wails/releases), [annonce de la beta](https://docs-preview.wails.io/blog/wails-v3-beta/), [jalon v3.0.0 GA](https://github.com/wailsapp/wails/milestone/10), code source de `github.com/wailsapp/wails/v3@v3.0.0-beta.34` et `v2@v2.16.0`.
- Electron : [notes de la 45.0.0](https://github.com/electron/electron/releases/tag/v45.0.0), [calendrier](https://releases.electronjs.org/schedule), [BrowserWindow](https://github.com/electron/electron/blob/v45.0.0/docs/api/browser-window.md), [nativeTheme](https://github.com/electron/electron/blob/v45.0.0/docs/api/native-theme.md), [protocol](https://github.com/electron/electron/blob/v45.0.0/docs/api/protocol.md), [utilityProcess](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md), [autoUpdater](https://github.com/electron/electron/blob/v45.0.0/docs/api/auto-updater.md), [onglets macOS (#40529)](https://github.com/electron/electron/issues/40529), [Squirrel.Mac](https://github.com/Squirrel/Squirrel.Mac/blob/HEAD/Squirrel/SQRLCodeSignature.m), [electron-builder, signature macOS](https://github.com/electron-userland/electron-builder/blob/master/website/docs/features/code-signing/code-signing-mac.md).
- [codiff](https://github.com/nkzw-tech/codiff) au commit `ab0653c` : `electron/main.cjs`, `forge.config.cjs`, `electron/updater.cjs`, releases.
- Benchmarks : [Elanis, web-to-desktop-framework-comparison](https://github.com/Elanis/web-to-desktop-framework-comparison), [tauri#5889](https://github.com/tauri-apps/tauri/issues/5889), et le benchmark v2/v3 de la branche `desktop/wails-v3`.
- Apple : [contenu d'un bundle](https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle), [Gatekeeper sous macOS 15](https://developer.apple.com/news/?id=saqachfa).
