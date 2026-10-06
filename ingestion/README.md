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
the 16/09 collection found usable without a browser: Shopify
(`/products.json`) and the WooCommerce Store API. It honors `robots.txt`,
waits a second between two requests to the same host, identifies itself, and
retries the flaky sites. Sites with neither API (PrestaShop, Wix) are listed in
the report as such: they need HTML parsing or a browser, out of scope here.

It writes **candidates**, never wines: `ingestion/candidates/<date>/`, ignored
by git, with one JSON file per wine, the product text it was taken from, and a
`REPORT.md`. Products are excluded with a stated reason when they are not a
single 75 cl bottle, not a Pic Saint-Loup (the appellation must be named, not
only the terroir), white, or of an unclear color. Fields the page does not
state clearly are left null and flagged rather than guessed. The tasting note
is made of the page's descriptive sentences, copied as they are.

Review each candidate (fix a field, delete the file, or keep it as is), then
promote the folder, or single files; `npm run collect` prints the exact path:

```bash
npm run collect:promote -- ingestion/candidates/2026-10-07
npm run db:seed && npm run db:embed
```

Promotion checks again what must hold: the schema, a producer from the
directory, known grapes, the AOC grape rules read from the seed (syrah share,
secondary grapes, number of main grapes), no duplicate of a wine already in
the catalog, the note made of sentences copied verbatim from the page (a note
reworded during review is refused), and the injection quarantine. The wine is
then written to `db/seed/wines/` with a `_provenance` line.

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
