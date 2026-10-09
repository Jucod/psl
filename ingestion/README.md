# Milestone 5: tech sheet extraction

PDF tech sheet → JSON matching `db/schema/wine.schema.json`.

```bash
python3 -m venv .venv && .venv/bin/pip install -r ingestion/requirements.txt

.venv/bin/python ingestion/extract.py ingestion/sheets/*.pdf --output ingestion/output
.venv/bin/python ingestion/measure.py
```

## Collecting more wines

```bash
# .env: PSL_COLLECT_CONTACT=you@example.org   (sent in the user-agent)
npm run collect                                   # every estate with a website
npm run collect -- --producer domaine-de-morties  # or a few, comma-separated
```

The collector reads each estate's shop through the two public product APIs
when it has one: Shopify (`/products.json`) and the WooCommerce Store API.
Otherwise (PrestaShop, Wix, WordPress themes...) it reads the HTML pages,
without a parser per site, through what platforms publish for search engines:

1. the product pages are found in the sitemaps declared in `robots.txt` (or
   `/sitemap.xml`, `/wp-sitemap.xml`), product sitemaps first; without a
   sitemap, through the links of the home page and of its wine-list pages;
2. each page is read from its schema.org `Product` data (JSON-LD, then
   microdata, then Open Graph), plus its description blocks and feature tables
   (vintage, grapes, alcohol). `--max-pages` caps the pages read per site (40).

A wine page without structured product data is not read: it is listed in the
report, to be looked at by hand, rather than guessed from its layout. Every
request honors `robots.txt`, waits a second per host, identifies itself, and
retries the flaky sites.

It writes **candidates**, never wines: `ingestion/candidates/<date>/`, ignored
by git, with one JSON file per wine, the product text it was taken from, and a
`REPORT.md` that counts exclusions by reason.

The catalog holds the still wines of the estates under the five designations
of the reference data: AOP Pic Saint-Loup, AOP Languedoc, AOP Grés de
Montpellier, IGP Saint-Guilhem-le-Désert and Vin de France, whites included.
Only what is certainly outside it is excluded:

- products that are not a single bottle of wine: gift boxes and packs,
  accessories, events, visits, workshops and gift cards, and the estate's
  other products (hydrolats, vinegar, marc, oil...), every one of them met in
  a shop of the directory;
- home and range pages read as a product ("Accueil", "Nos vins"), and pages on
  which nothing describes a wine (no color, designation, grape, vintage or
  alcohol content);
- boxes described by their content ("Deux bouteilles de 75 cl..."), large
  formats (in the title or only in the address, "...-150cl"), sparkling
  wines, and IGPs outside the reference data (Pays d'Oc, Pays d'Hérault...).

When the directory points an estate to its page in a shop it shares with
other estates (Château L'Euzière in the Vignobles Vellas shop, Mas Pages on
Plugwine), only the products that page links to are read: the shop's sitemap
or product API would file every wine it sells under the estate.

Everything merely uncertain is kept:

- **ready**: the page names one designation (the Pic Saint-Loup under its
  former name, "AOC Coteaux du Languedoc Pic Saint-Loup", included) and a
  color that designation covers;
- **to complete**: the page names Pic Saint-Loup only as a place, states no
  designation, names several that its title does not settle, names one that
  does not cover the wine's color (a white "AOP Pic Saint-Loup"), or does not
  say the color. The field is left empty and `_review.to_complete` says what
  to decide: set it from the label, or delete the file.

Other uncertain fields (vintage, price, blend) are left null and flagged
rather than guessed. The tasting note is made of the page's descriptive
sentences, copied as they are.

Review each candidate (fix a field, delete the file, or keep it as is), then
promote the folder, or single files; `npm run collect` prints the exact path.
Promoted files move to a `promoted/` subfolder, so the command can be run
again on the same folder after completing the others:

```bash
npm run collect:promote -- ingestion/candidates/2026-10-07
npm run db:seed && npm run db:embed
```

When the same decision holds for many "to complete" files (you checked that an
estate's wines are all Vins de France), `--set appellation_id=vin-de-france`
(or any designation of the reference data) or `--set color=red|rose|white`
fills that field where it is empty, and says so in each promoted wine's
provenance. Promote such a batch on its own folder or files: the decision
applies to every file of the command.

Promotion checks again what must hold: the schema, a producer from the
directory, known grapes, a designation of the reference data that covers the
wine's color, the grape rules of that designation where the seed transcribes
them (today the Pic Saint-Loup's: syrah share, secondary grapes, number of
main grapes), no duplicate of a wine already in the catalog, the note made of
sentences copied verbatim from the page (a note reworded during review is
refused), and the injection quarantine. The wine is then written to
`db/seed/wines/` with a `_provenance` line.

## Why Python here, and only here

The runtime is TypeScript. Python only steps in for PDF extraction, where
`pdfplumber` and OCR have no equivalent on the Node side.

**The scope stops at "PDF → JSON".** This script knows neither Postgres, nor
embeddings, nor the API: it reads one file and writes another. As soon as it
touches the database, the split becomes two toolchains to maintain for a
single person, and the cost outweighs the benefit.

The contract between the two languages is a file: `db/schema/wine.schema.json`,
generated from zod by `npm run schema:export` and committed. `extract.py`
validates its output against it before writing. A schema changed without being
exported again makes `tests/schema-export.test.ts` fail.

## The guardrail that matters

`Extractor.verbatim()` rejects any text value absent from the PDF's text
layer. A rejected field is `null`: **a gap is better than an invention.**

It is the only place in the pipeline where a hallucination would go unnoticed.
The rest of the system works on data already in the database, protected by the
Postgres constraints. Here, the data is being made, and the day extraction goes
through a vision model, it is this function, and it alone, that will prevent a
tasting note from being written rather than read.

## The error rate is the deliverable

`measure.py` compares the output with a set checked by hand (`expected/`) and
tells four outcomes apart per field:

| | |
|---|---|
| `exact` | the extracted value is the one collected by hand |
| `divergent` | a value was extracted, but it is wrong |
| `missing` | nothing was extracted although there was something |
| `spurious` | something was extracted although there was nothing |

`divergent` is the serious case and it is counted separately: **wrong data
costs more than missing data.** An empty field goes to review; a wrong field
passes for correct.

This output is what is shown to the client, not an assumed quality.

## What the extractor deliberately does not do

The `estate-c-prose` sheet never states the wine's color. A human reviewer
infers it from "robe grenat", "mûre", "tanins fermes". The extractor does not,
and it is **counted as an error, not excused**.

Inferring would have produced a field that looks right and that nobody checks
again. Not inferring produces a gap, which shows up in the report and goes to
review. Inference, if wanted, is a separate review step traced as such, not a
side effect of extraction.

## The test corpus

`sheets/` contains three PDFs produced by `make_test_sheets.mjs` (Chromium
printing to PDF), with deliberately different layouts: a table, labeled lines,
prose without standard headings. That is the reality of a corpus of sixty
estates: each one has its own template.

**Limit to state before showing a figure:** these sheets were made here, so
measuring the extractor on them is partly circular. The rate obtained on this
corpus is not predictive of the real one. The measurement bench is the
deliverable; the figure will only be meaningful on real sheets, checked by
hand.

Network egress from the development environment blocks the estates' websites:
no real sheet could be retrieved.

## Next steps

1. Parse the syndicate directory: a single structured page, one entry point,
   not sixty websites to crawl blindly.
2. Locate the PDFs on each website (`/nos-vins`, `/la-cave`, trade area).
   Honor `robots.txt`, limit the rate, use an identifiable user-agent.
3. Review the first batch by hand, freeze it in `expected/`, and measure.
4. If the sheets are scans: OCR upstream, nothing else changes. If rule-based
   extraction plateaus, switch to a vision model: `verbatim()` remains the
   acceptance condition.
