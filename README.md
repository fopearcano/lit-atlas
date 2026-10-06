# Literary Atlas

A web-based visual atlas of world literature. 166 works from every inhabited continent — from *Gilgamesh* to Han Kang — mapped by **place**, **time**, the **concepts** they explore and the **values** their cultures hold, with 105 documented **connections** between them.

## Views

| View | What it shows |
| --- | --- |
| **Map** | Each work where it is rooted; arcs trace influence, response and kinship across the globe. Zoom and pan. |
| **Constellation** | A force-directed network: works orbit the concept (or value) hubs they share. |
| **Timeline** | Four thousand years in parallel lanes per literary region, with arcs leaping across centuries. |
| **Values Compass** | Works placed on two interpretive axes — *self ↔ collective* and *continuity ↔ change* — derived from their tagged values. |
| **Concepts × Cultures** | A heatmap of how strongly each concept (or value) runs through each region's literature. |

Everything is linked: select a work, concept, value, region or matrix cell and every view highlights the same set. Selecting a work shows what shaped it, what it shaped, the works that answer or rewrite it, kindred works, and works that share its ideas (computed from concept overlap).

**Journeys** are curated trails — *Writing Back to Empire*, *The Road to Magical Realism*, *Fables That Crossed the World* and more — that you can step through with the arrow keys.

State is kept in the URL hash, so any view/selection can be shared (e.g. `#view=timeline&work=hundredyears`).

## Running

No build step. Open `index.html` directly, or serve the folder:

```sh
npm start          # python3 -m http.server 8000
```

D3 and topojson-client load from CDNs, as does the Natural Earth world outline (`world-atlas`).

## Data

All content lives in [`js/data.js`](js/data.js):

- `regions` — eight literary regions (colour identity).
- `concepts` — 25 themes a work explores.
- `values` — 19 cultural values, each with a position on the compass axes.
- `books` — title, author, year (negative = BCE, `approx` for dates that are uncertain), place, coordinates, language, concepts, values, one-line summary.
- `links` — `influence` (A shaped B), `response` (B answers or rewrites A) and `kinship` (often read together), each with a short note on the connection.
- `journeys` — ordered trails of works.

Concept and value tags and the compass placement are editorial — a lens for exploring, not a verdict.

Check the dataset's integrity (unknown ids, duplicate links, influences that run backwards in time, unused tags):

```sh
npm test
```

To add a work, append a row to `rows` in `js/data.js`, optionally add links, and run `npm test`.
