# Milestone 5: tech sheet extraction

PDF tech sheet → JSON matching `db/schema/wine.schema.json`.

```bash
python3 -m venv .venv && .venv/bin/pip install -r ingestion/requirements.txt

.venv/bin/python ingestion/extract.py ingestion/sheets/*.pdf --output ingestion/output
.venv/bin/python ingestion/measure.py
```

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
