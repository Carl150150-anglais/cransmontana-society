# cransmontana.society — robot de contenu

Ce dépôt fabrique des lots d'images prêtes à poster pour **@cransmontana.society** : une photo sombre et haut de gamme, une citation courte au centre, le nom de la page en haut, le monogramme CM en bas. Format **1080 × 1350 PNG**.

Les lots sont publiés sur GitHub Pages pour que tu les relises et qu'un planificateur puisse les récupérer par URL publique.

> **Règle absolue : rien n'est jamais posté automatiquement depuis ce dépôt.** Le robot produit des fichiers, c'est tout. Pas de publication sur Instagram, pas d'appel à Metricool, pas de likes ni de follows automatiques.

**Galerie de relecture :** https://carl150150-anglais.github.io/cransmontana-society/

## Installation (une seule fois)

```sh
npm install
npm run browsers   # Chromium pour Playwright, installé dans node_modules
npm run fonts      # Jost et Bodoni Moda (déjà présentes dans assets/fonts/)
```

La clé Unsplash se met dans `.env`, à la racine, et tu la saisis toi-même depuis ton Terminal :

```
UNSPLASH_ACCESS_KEY=ta_access_key
```

`.env` n'est jamais commité (il est dans `.gitignore`).

## Ajouter tes propres photos

Dépose-les dans `photos/own/` en les nommant `<thème>_<nom>.jpg`, par exemple `chalets_salon-hiver.jpg`.

Thèmes : `ambition`, `mountain`, `discipline`, `cars`, `watches`, `chalets`, `ski`, `golf`, `dining`, `jewels`, `fashion`.

- Tes photos passent **avant** celles d'Unsplash, et n'ont pas de ligne de crédit.
- Pour convertir un HEIC d'iPhone : `sips -s format jpeg photo.heic --out photos/own/ski_matin.jpg`.
- Le cadrage est automatique (portrait 4:5, centré). Garde le sujet au milieu de l'image.

## Les commandes

| Commande | Rôle |
| --- | --- |
| `npm run fetch` | Télécharge des photos Unsplash, jusqu'à 4 par thème (`-- --per-theme 6` pour plus). |
| `npm run check` | Vérifie la banque de citations (longueur, mots interdits, doublons…). |
| `npm run build` | Construit un lot de 30 posts nommé à la date du jour. |
| `npm run sheet -- --batch 2026-10-21` | Régénère la planche contact d'un lot. |
| `npm run publish` | Commite `docs/` et `state/`, puis pousse sur GitHub. La galerie se met à jour en quelques minutes. |

### `fetch`

- Tour démo Unsplash : 1 requête par seconde, 40 requêtes par passage, 50 par heure.
- Chaque photo téléchargée coûte une requête de suivi, exigée par Unsplash.
- Les photos déjà vues ne sont jamais retéléchargées (`state/unsplash-seen.json`).
- Pour écarter une photo, supprime son `.jpg` et son `.json` dans `photos/unsplash/`. Elle ne reviendra pas, et le prochain `fetch` la remplacera.
- Les photos évoquant fêtes, vie nocturne, feux d'artifice ou deuil sont filtrées. Les photos de personnes vues de dos, de profil ou en silhouette passent en priorité, et les poses suggestives sont écartées.

### `build`

```sh
npm run build                                       # 30 posts, lot du jour
npm run build -- --count 20 --batch 2026-11-02      # autre taille, autre nom
npm run build -- --dry-run                          # affiche le plan, ne fabrique rien
npm run build -- --batch 2026-10-21 --redo 03,07    # nouvelle photo du même thème pour ces numéros
```

- **Choix des citations.** Les citations déjà utilisées sont exclues (`state/used.json`) et les thèmes sont équilibrés.
- **Saisons.** Les citations d'hiver sortent de novembre à mars, celles d'été de mai à septembre, les autres toute l'année.
- **Photos.** Chaque photo sert une seule fois, tous lots confondus (`state/photos-used.json`). Si un thème n'a plus de photo, le lot emprunte des photos de montagne.
- **`--redo`.** Change la photo des numéros indiqués et garde la même citation, sans toucher aux autres posts. La photo remplacée ne revient pas.

Un lot produit, dans `out/<lot>/` (local, non versionné) :

- `NN_<citation>.png` : les images à poster ;
- `captions.md` : pour chaque post, la légende prête à copier (phrase, ligne de crédit, hashtags) ;
- `posts.json` : fichier, citation, thème, source de la photo, crédit, légende, `public_url` ;
- `contact-sheet.png` : la planche de relecture.

Les PNG et `posts.json` sont copiés dans `docs/posts/<lot>/`, ce qui les rend publics après `npm run publish`.

## La ligne de crédit 📷

Chaque post fait avec une photo Unsplash a une ligne `📷 <photographe> via Unsplash` dans sa légende.

Les règles de l'API Unsplash demandent de créditer le photographe pour toute photo obtenue par l'API. **Garde cette ligne quand tu postes.** La galerie, elle, crée un lien vers le profil du photographe et vers Unsplash.

## Organisation

```
src/          scripts (fetch, build, render, sheet, publish, check-quotes, fonts)
src/template.html   gabarit du post (1080 × 1350)
quotes/       200 citations, 40 légendes et hashtags
assets/fonts/ polices hébergées dans le dépôt
photos/       own/ et unsplash/ (non versionnés)
state/        citations et photos déjà utilisées, photos Unsplash vues
out/          lots générés (non versionnés)
docs/         galerie GitHub Pages et lots publiés
```
