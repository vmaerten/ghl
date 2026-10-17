# Benchmark desktop : Electron, Tauri, Wails et TinyJS

Mesures locales du 11 octobre 2026 sur macOS-26.6.2-arm64-arm-64bit-Mach-O, Apple M5 Pro, 48 Gio de RAM. Trois passages par combinaison ; 24 lancements au total. Le [JSON brut](./desktop-benchmark.json) conserve versions, hashes, processus et intervalles de frames.

Le benchmark compare des enveloppes desktop en mode production autour du **même backend Go et de la même interface React**, avec une fenêtre vide puis un dépôt temporaire de 100 fichiers TypeScript : 20 000 lignes supprimées et 20 000 ajoutées. Les contenus et la surface visible de 1280×720 sont vérifiés. Le backend Go reste externe pour les quatre variantes.

## Mémoire et distribution

Médianes des trois passages, en Mio. La mémoire correspond à la **physical footprint macOS**, avec les processus de rendu, réseau et GPU attribués à chaque application ; le total en charge ajoute le backend Go. RSS est conservé séparément dans le JSON.

| Enveloppe | Fenêtre vide | Gros diff, Go inclus | Plage du gros diff | Bundle + Go/React |
| --- | ---: | ---: | ---: | ---: |
| Electron 44.7.0 | 77.0 | 453.7 | 451.2–455.7 | 304.5 |
| Tauri 2.12.3 | 73.8 | 486.7 | 433.8–520.3 | 27.0 |
| Wails 2.16.0 | 73.7 | 430.2 | 421.1–432.5 | 25.8 |
| TinyJS v0.50.1 | 77.7 | 460.5 | 453.7–543.3 | 27.0 |

Les bundles sont mesurés avant compression, par somme des fichiers réguliers sans suivre les symlinks. Le Go ajouté contient déjà les assets React. Les frameworks système macOS restent hors des bundles. Ces tailles ne sont pas des tailles de téléchargement.

Les fenêtres vides sont proches en empreinte physique : le RSS fait apparaître un écart plus grand, notamment pour Electron, mais additionne des pages partagées. Il ne permet pas de conclure à une économie équivalente de RAM système. En charge, Wails a la plus petite médiane dans cet échantillon ; Tauri et TinyJS varient sensiblement entre les passages. Le détail des processus situe une grande partie de cette variation dans le GPU WebKit : 23–102 Mio pour Tauri, 23–102 Mio pour TinyJS, contre 23–30 Mio pour Wails. Ce n’est pas une mesure d’un surcoût du langage Rust ou JavaScript. Aucun classement universel ne découle de trois mesures.

## Démarrage et parcours du diff

Le démarrage total ajoute le démarrage du Go à l’ouverture de la fenêtre jusqu’au rendu de l’arbre, des lignes et de la coloration. Les caches OS sont présents : ce sont des processus neufs, pas un démarrage à froid de la machine.

| Enveloppe | Démarrage du gros diff | Intervalle rAF p95 | Plus long intervalle observé | CPU du parcours |
| --- | ---: | ---: | ---: | ---: |
| Electron | 0.70 s | 13.4 ms | 24.4 ms | 3.64 s |
| Tauri | 1.41 s | 23.0 ms | 40.0 ms | 4.48 s |
| Wails | 1.54 s | 23.0 ms | 40.0 ms | 4.46 s |
| TinyJS | 1.51 s | 23.0 ms | 37.0 ms | 4.45 s |

Le parcours programmatique va du début à la fin en cinq secondes puis attend une seconde de stabilisation. Le dernier fichier apparaît et le nombre de fichiers montés reste borné. Les intervalles `requestAnimationFrame` mesurent les callbacks de ce workload, **pas les FPS du compositeur ni la latence clavier/souris**. CPU couvre les processus applicatifs mesurés ; les processus Git très courts ne sont pas cumulés.

Des notifications `ResizeObserver loop completed with undelivered notifications` apparaissent pendant le parcours dans les quatre variantes, avec 99 occurrences par passage sur cette fixture. Elles sont conservées comme avertissements ; aucune erreur JavaScript fatale n’a été acceptée. Le même contenu atteint la fin dans toutes les variantes.

## Ce que cela permet de décider

- Une WebView système réduit fortement la taille distribuée, mais ne garantit pas une petite RAM : React, le patch analysé, Shiki et les moteurs de rendu dominent ce gros diff.
- Electron offre ici un meilleur démarrage et des callbacks de parcours plus réguliers, au prix d’un bundle nettement plus grand.
- Wails reste le candidat naturel à prototyper avec notre backend Go. Une intégration directe peut éviter le second runtime Go et la navigation initiale de cette enveloppe ; ce gain n’est pas mesuré ici.
- TinyJS est une alternative JavaScript/txiki.js avec WebView système. Garder notre Go lui ajoute un processus compagnon ; il ne remplace pas automatiquement notre backend.
- Tauri reste un candidat viable, mais ajoute une chaîne Rust. Sa variabilité mémoire mérite d’être vérifiée sur des dépôts représentatifs avant un choix final.

Ce test ne couvre pas l’édition de commentaires native, le presse-papiers, la distribution signée/notarisée, les mises à jour ou le hot reload des futurs adaptateurs. Les processus système partagés comme WindowServer et le harness sont exclus des chiffres.

## Comparaison avec Chrome et accumulation d’onglets

Trois passages supplémentaires avec **Chrome for Testing 154.0.8037.92**, dans des profils temporaires isolés, réutilisent exactement la fixture, le patch, le Go et la sonde du benchmark desktop. Le [JSON Chrome brut](./desktop-chrome-benchmark.json) conserve les processus, les flags d’automatisation, les hashes et les neuf parcours. Le navigateur personnel reste intact.

Chaque passage chauffe Chrome avec un onglet vide, ouvre une première review, ouvre une deuxième review identique puis renavigue ce deuxième onglet. Le premier onglet de review reste ouvert. Les nombres d’onglets sont vérifiés : 2, 3, 3, onglet vide inclus. Go reste le même processus durant les trois phases.

| État | Empreinte totale Chrome + Go | Coût supplémentaire mesuré | Ouverture jusqu’au diff coloré |
| --- | ---: | ---: | ---: |
| Chrome chauffé, onglet vide, sans Go | 170.5 Mio | — | — |
| Première review | 592.9 Mio | +422.4 Mio, Go inclus, par rapport au navigateur vide | 0.30 s ; 0.39 s avec le démarrage Go |
| Deuxième onglet de review | 840.3 Mio | +244.4 Mio pour Chrome seul, juste avant/après cette ouverture | 0.29 s |
| Renavigation du deuxième onglet | 717.7 Mio | −118.7 Mio pour Chrome seul, juste avant/après cette navigation | 0.26 s |

Ce sont des médianes de mesures appariées ; les différences entre médianes des totaux ne donnent pas nécessairement la médiane des deltas. Le premier surcoût varie de 421.8 à 424.6 Mio ; celui du deuxième onglet de 241.2 à 321.8 Mio. Les processus partagés et leur mémoire peuvent évoluer entre deux relevés. La diminution après renavigation comprend les libérations du moteur et des caches dans cet échantillon ; **elle ne garantit pas une économie de 119 Mio à chaque navigation**. Le test vérifie surtout que réutiliser un onglet garde le nombre d’onglets constant.

Le premier onglet ajoute environ 422 Mio au Chrome chauffé, Go compris, face à 430 Mio pour une application Wails complète sur le même gros diff. Le budget supplémentaire est donc proche dans cet échantillon. Le total de 593 Mio comprend le navigateur qui existait déjà : le comparer seul aux 430 Mio de Wails surestime le coût supplémentaire pour quelqu’un dont Chrome tourne déjà. La première review Chrome a un rAF p95 médian de 14.3 ms et un CPU de parcours de 3.84 s, sans erreur JavaScript fatale ; les mêmes 99 avertissements ResizeObserver par parcours sont conservés.

Un Chrome vide chauffé représente uniquement une baseline contrôlée, pas les extensions et autres pages du navigateur quotidien. Chrome et Electron ont des versions Chromium différentes. La surface React est vérifiée à 1280×720, avec émulation Puppeteer dans une fenêtre Chrome de 1280×820 ; la barre du navigateur reste incluse dans sa mémoire. Ces deltas portent sur la famille de processus du navigateur, pas sur la RAM totale du système.

Le CLI actuel appelle `open <URL>` sur macOS à chaque invocation et ne retrouve pas un onglet existant. Pour l’usage souhaité, une application desktop à **instance unique** peut afficher ou remettre au premier plan la même fenêtre et changer de dépôt, évitant d’accumuler les vues. Ce comportement reste à implémenter : le framework seul ne le garantit pas. La renavigation Puppeteer démontre la réutilisation dans notre navigateur contrôlé ; elle n’ajoute pas la recherche d’onglets au CLI de production.

## Reproduire

Le [protocole et les prototypes](../poc/desktop-bench/README.md) décrivent les dépendances, la mesure des processus XPC sous launchd, la conversion du temps Mach, la calibration des fenêtres et les limites.

```bash
task desktop:bench
# Après installation du Chrome de test indiqué dans le protocole :
task desktop:chrome -- --chrome '<chemin de l’exécutable Chrome for Testing>'
```

Aucune CI ni publication. Sources des quatre enveloppes : commit `6a6acc2622202bea496449db8560997a481f0250` ; la suppression ultérieure des fichiers TinyJS générés et la rédaction de ce bilan ne modifient pas les enveloppes. La baseline Chrome est ajoutée dans la même PR, avec le même backend. Les binaires exacts ont leurs SHA-256 dans les JSON.

Références primaires : [Electron](https://www.electronjs.org/docs/latest/tutorial/process-model), [Tauri](https://v2.tauri.app/concept/process-model/), [Wails](https://wails.io/docs/introduction/), [TinyJS](https://tinyjs.app/docs.html), [architecture multiprocessus Chromium](https://www.chromium.org/developers/design-documents/multi-process-architecture/).
