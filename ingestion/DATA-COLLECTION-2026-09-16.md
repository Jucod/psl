# Data collection of 16 September 2026: from fixtures to real data

This document states where every field now in the database comes from, and
what is still missing. For the six estates covered, it replaces the
`dev_fixture` label that so far carried the whole descriptive layer.

## What was collected

### 1. Producer reference data: complete

`db/seed/pic-saint-loup-seed.json`, `producers` block.

The syndicate's directory is a WordPress application exposing a `domaine`
content type: `GET /wp-json/wp/v2/domaine?per_page=100` returns the **74
producers** of the appellation. The details (address, commune, contact, phone,
website) are not in the API but in each producer's HTML page, under a stable
structure where each block is labeled by the `alt` of its icon (`position`,
`nom`, `horaire`, `phone`, `lien-site-web`, `contact`).

74 pages retrieved, one request per second, identifying user-agent.

Coverage of what the syndicate publishes:

| field | coverage |
|---|---|
| name | 74 / 74 |
| commune | 67 / 74 |
| phone | 72 / 74 |
| address | 67 / 74 |
| website | 56 / 74 |

Result: **71 estates + 3 cooperative wineries**, against 5 estates and 3
cooperatives in the previous seed. The collection is kept in
`ingestion/collected/syndicate-directory-2026-09-16.json`, reduced to the
fields the project uses: slug, name, commune, website.

**No personal data is kept.** The syndicate's pages also carry contact names,
phone numbers, e-mail addresses, postal addresses and a description written by
each estate. The code reads none of them, so none of them is stored in the
repository, nor in its history: data you do not need is data you do not have
to protect. The descriptions are left out for a second reason, the one behind
step 6 of the ingestion plan: the text belongs to the estates.

Two communes are outside the 17 of the AOC (Teyran, Saint-Drézéry): these are
members headquartered outside the area, not a collection error.

### 2. Wines: 15 real pages, 6 estates

`db/seed/wines/`. Every value comes from the pages published by the estates
themselves, under a source of type `producer_page` carrying the exact URL and
the collection date.

| estate | wines | what the page provided |
|---|---|---|
| Mas Bruguière | L'Arbouse 2024, La Grenadière 2024 | blend with percentages, appearance, nose, palate, pairings, aging potential, price |
| Bergerie du Capucin | Dame Jeanne rouge 2022 and 2023, **Dame Jeanne rosé 2025**, Larmanela 2021 | full tech sheet: grapes, **ABV**, soils, vine age, harvest, aging, pairings, storage, price |
| Domaine Coste Ubesse | Moja Negra 2020, Moja Negra Tête de Cuvée 2019, Le Cazal 2020 | blend, detailed aging, Ecocert certification, price |
| Domaine de Mortiès | Pic Saint Loup 2024, Jamais Content 2024, Que Sera Sera 2024 | blend with percentages, winemaking, aging, production, price |
| Mas Foulaquier | L'Orphée 2023, Les Calades 2024, Picaleòn 2024 | blend with percentages, terroir, biodynamics, aging, price |

Validated by the project's own loader (`loadWines`, `WineSchema`): **17 valid
wines** (15 new + the 2 Lancyre still without a note), 0 orphan estate, 0 grape
outside the reference data, every blend with percentages adds up to 100%, and
**no wine breaks the AOC grape rule** (syrah ≥ 50% for red, ≥ 30% for rosé).

Two gaps flagged in the previous session are filled:

- **a real AOP rosé**: Dame Jeanne rosé 2025, 13 €;
- **the volume**: 17 wines instead of 5, so `maxResults: 3` now returns 18% of
  the catalog rather than 60%. The vector ranking finally has something to
  work with.

## What I did not take, and why

### The Hachette page

`hachette-vins.com/tout-sur-le-vin/appellations-vins/558/pic-saint-loup` is
reachable and its `robots.txt` does not forbid it. It splits into two halves
that must not be confused.

**Usable: the facts.** An index of 29 starred wines with estate and vintage, 12
producers, and indicative prices. A fact cannot be protected, and this index is
an excellent *collection plan*: it says which wines exist and which vintage is
current, hence which producer page to go to. That is how I used it.

**Not usable: the guide's notes.** The "coups de cœur" are written criticism:
the Guide's work, not the producer's factual sheet. Copying them into
`tasting_note` and then embedding them would amount to republishing the
editorial content of a commercial guide: exactly what step 6 of the ingestion
plan forbids, and the riskiest point of the whole project if the demo goes to
a prospect. The schema has no source type for a guide, which is a good thing:
do not add one.

A discrepancy noticed along the way: Hachette dates the AOC recognition to
**2017**, the seed says **2016** based on the INAO specification. INAO is the
authority; the seed stays unchanged.

### Château de Lancyre

The two Lancyre wines stay without a note, with their `dev_fixture` overlay.
`chateaudelancyre.com` alternates between 200s and failed TLS handshakes, and
the official shop (`chateaulancyre-laboutique.com`) is a Wix site whose catalog
is rendered in JavaScript: nothing usable over plain HTTP. To be picked up again
with a headless browser, or through the PDF sheets if the estate publishes
them. Hachette also confirms that the current vintage of Vieilles Vignes is
**2023**, not 2022 as the file's identifier still says.

### Wines deliberately left out

- **Les Mûriers (Mas Bruguière)** and the Bergerie's whites: AOP Languedoc or
  IGP Saint-Guilhem-le-Désert, not Pic Saint-Loup. They confirm the project's
  rule on real cases (a white from the area is released under another label),
  but the `appellations` table only contains the Pic Saint-Loup AOC, so the
  foreign key would reject them. Loading them first requires adding those
  appellations to the reference data.
- **Les Tonillières (Mas Foulaquier)**: 70% carignan, 30% grenache. The page
  talks about the Tonillières *terroir* "en Pic Saint-Loup" without naming the
  appellation, and this blend would be incompatible with it. Left out for lack
  of a way to decide.

## What is still missing

1. **Alcohol content.** Only Bergerie du Capucin publishes the ABV. 13 wines
   out of 15 have `abv: null`. It is the field least served by retail sites.
2. **The PDF tech sheets.** The Bergerie offers four for download; their server
   sends them with `Content-Length: 0`. The files are therefore empty at the
   source, not blocked. The extraction measurement bench (milestone 5) still
   runs on the three home-made PDFs: **the 3% rate remains worthless**. The
   sheets have to be requested from the estates, or picked up at the cellar.
3. **Cautious `organic`.** Only set when the page says so: `true` for Mas
   Bruguière and the Bergerie, `true` + `Ecocert` for Coste Ubesse. Left
   `null` for Mortiès and Foulaquier: Foulaquier advertises biodynamics, which
   implies organic farming, but no certification is named and I did not want
   to infer it.

## Two defects found along the way

**1. The seed loaded zero wines on Windows, silently.**
`new URL('../../db/seed/wines/', import.meta.url).pathname` yields
`/C:/Users/...`, which Node resolves to `C:\C:\Users\...`, hence `ENOENT`,
caught by a silent `catch` that returned `[]`. `npm run db:seed` would have
ended "successfully" on an empty catalog. Nine occurrences fixed with
`fileURLToPath`.

**2. The `catch` itself.** It confused two situations: the fixture overlay
missing, which is normal and even desirable in production, and the base
directory unreadable, which is a failure. `readJsonDir` now takes an
`optional` flag; a missing or empty base directory raises an error.

`npm run typecheck` passes. The test suite requires a local Postgres that is
not initialized on this machine, and could therefore not be run.

## Reproducing

The network to these estates is unstable: several websites alternate between
200s and failed TLS handshakes from one minute to the next. A single pass gives
a false picture: out of 56 websites, a first pass found 46 reachable, a second
one with `--retry 2` found more, including Mas Bruguière, which had been
classified as unreachable. **Always retry before concluding that an estate is
offline.**

Only six websites expose a public product API: the WooCommerce Store API
(`/wp-json/wc/store/v1/products`) for Coste Ubesse, La Triballe, La Chouette du
Chai and Mas Bruguière, Shopify's `/products.json` for Mortiès and Mas
Foulaquier. The others require HTML: PrestaShop renders its pages server-side
and parses well (Bergerie du Capucin); Wix gives nothing without a browser.
