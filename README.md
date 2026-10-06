# Pic Saint-Loup

Conversational search engine over a product catalog. A visitor describes a need
in natural language, the system turns the request into explicit filters,
queries the catalog, and answers while citing its sources.

The subject is wine. **The product is the engine.** Turning a request into
SQL, relaxing constraints and refusing out-of-catalog requests are driven by
a declarative domain config (`src/config/`); the engine core does not name
"color" or "vintage". The result projection and the appellation fallback are
still wine-specific: see "Reusability" below.

The product itself speaks French: the visitor's requests, the tasting notes,
the lexicon and every message shown on screen are in French. The code, the
schema and the documentation are in English.

---

## Getting started

```bash
# 1. A Postgres 16 database with pgvector
docker compose up -d
#    or, without Docker, on a machine where postgresql-16 is installed:
#    bash scripts/bootstrap-postgres-local.sh

# 2. Configuration
cp .env.example .env

# 3. Schema, data, vectors
npm install
npm run setup

# 4. API + interface
npm run api          # http://localhost:3000
npm run web:dev      # http://localhost:5173 (dev, proxied to the API)
```

Everything works without an API key: the `local` embedding and LLM providers
are deterministic and offline. See "Providers" below.

```bash
npm run demo -- "un rouge pas trop tannique pour un gigot, autour de 20 euros"
npm test             # creates and resets its own <db>_test database
```

---

## The behavior contract

This is the heart of the project, and it takes precedence over the perceived
quality of the answers. What sets this implementation apart: **the guarantees
are enforced as Postgres constraints, not as prompt instructions.** They hold
even if the model goes off the rails, and they can be demonstrated without it.

| Guarantee | Where it is enforced |
|---|---|
| No tasting note without a citable source | `CHECK note_requires_source` |
| No price without the date it was observed | `CHECK price_requires_date` |
| A white Pic Saint-Loup is impossible | composite FK `(appellation_id, color)` → `appellation_colors` |
| The description level cannot lie | `CHECK level_consistent` |
| A food pairing cannot become source data | `CHECK status = 'derived'` |

Refusing a white Pic Saint-Loup is **a query result**, not an instruction:
`tests/search.test.ts` checks it without any LLM call.

Five behaviors are visible on screen:

- **Coverage refusal**: "un vin blanc du Pic Saint-Loup" (a white Pic
  Saint-Loup) → explicit refusal citing the INAO specification. No
  approximate white is offered.
- **Grape refusal**: "avez-vous du chardonnay ?" → refusal citing the grape
  varieties the appellation permits. Grapes outside the appellation are
  recognized **on purpose** (`GRAPES_OUTSIDE_APPELLATION`): without that, the
  constraint evaporated and the system answered with three reds.
- **Empty**: "un rouge à base de cinsaut" → cinsault is permitted by the AOC
  grape rules, so no refusal is due, but no wine in the catalog contains it.
  An assumed empty answer, distinct from a refusal. The three states sit on
  the same axis: chardonnay is refused, cinsault is empty, syrah answers.
- **Missing data**: "autour de 20 €" when no price has been collected → "I
  cannot answer on this criterion". "No wine under 20 €" and "I have the price
  of no wine" are two different answers, and mistaking the second for the
  first is an unfounded statement.
- **Relaxation**: "moins de 12 euros" → nothing under 12 €, the budget is
  relaxed in 25% steps, capped at +50%, and **announced**. The appellation is
  never relaxed silently.

---

## Architecture

```
message ──► LLM call 1 ──► validated filters (strict schema)
                              │
                              ├─► hard constraints ──► SQL WHERE
                              └─► fuzzy part        ──► query vector
                                                          │
                            SQL query run by the CODE, never by the model
                                                          │
                              rows ──► LLM call 2 ──► text
```

Two deterministic calls, no autonomous loop, no orchestration framework.
Vectors only serve the fuzzy part ("souple", "frais"); price, vintage and
appellation are columns and `WHERE` clauses.

### Level separation

The seed suggested `embedding_text = producer note + appellation profile`.
**It is deliberately set aside.** Concatenating the AOC profile into every
vector makes all the wines of the appellation nearly collinear: the shared text
dominates the cosine and the ranking collapses.

- producer note present → it is embedded **on its own**, `embedding_level = 'wine'`;
- missing → no vector is made up, `embedding_level = 'appellation'`, search
  falls back on the AOC profile **and says so** in the interface.

### What switching to real data revealed

The fixture corpus validated the engine on a vocabulary I had written myself.
Fifteen producer pages brought out three defects that five invented sheets
could not show. It is the argument for shipping early on real data, rather than
polishing an engine on a lab corpus.

**The relaxation cap was decorative.** The ladder went up in 25% steps and gave
up as soon as the next step exceeded the +50% cap, instead of settling on it:
on a 12 € budget, it stopped at 15 € and answered "nothing found" while two
wines were at 16 € and the announced cap was 18 €. Invisible with the fixtures,
whose cheapest wine fell within the first step. A cap that cannot be reached
lies about what the system tried.

**The lexicon missed nominalizations.** `stem()` reduces `souple` to `soupl`
but `souplesse` to `soupless`, `rondeur` to `rondeur`, `charpentée` to
`charpente` while the key is `charpent`. As a result, a wine whose note
literally says "alliant gourmandise, **souplesse** et puissance" came out
**negative** on a request for a supple wine. The invented sheets said "souple"
and "tanins fondus", never "souplesse": real morphology is richer than the one
you produce when writing your own data.

The fix follows the existing design, which lists surface forms in `FAMILIES`
(`epice` **and** `epicee` are already there) rather than making the stemmer
more complex: touching `stem()` would have broken keys in place. The added
forms are all inflections of words **already** in their family, so no new
oenological judgment. The ranking gap went from 0.56 to 0.64.

**The word that gives the color was reused as a descriptor.** `stem('rose')`
is `ros`, and the rose is a flower of the floral lexicon: "un rosé" came back
with a `floral` descriptor nobody had asked for. With no rosé in the catalog,
it did not show.

### Reusability

`src/config/domain.ts` declares the filters, their column, their operator,
their relaxation mode and the coverage rule. `src/config/lexicon.ts` holds the
vocabulary. From that config alone, `src/engine/query.ts` builds the `WHERE`
clauses, and `src/engine/search.ts` runs the relaxation ladder and the
coverage refusal.

What is not config-driven yet, stated plainly: in `src/engine/search.ts`, the
result projection (`RESULTS_SQL`, with its per-column masking of the
development overlay), the fallback on the appellation profile, the dish
pairings and the catalog-size query name the wine tables and columns. Moving
to another business domain means rewriting the two config files **and** those
queries. That is a deliberate stopping point, not an oversight: no plugin
layer, no generic entity model, because the brief explicitly forbids
anticipating a second client that does not exist.

---

## Providers

| Variable | `local` (default) | Alternative |
|---|---|---|
| `PSL_EMBEDDING_PROVIDER` | bag of words + lexicon, offline, deterministic | `openai`, `mistral` |
| `PSL_LLM_PROVIDER` | rule-based parser + template formulation | `anthropic` |

The local provider is not just a stopgap: it demonstrates that the behavior
contract holds **without a model**. No text is generated, so nothing can be
invented; refusals and relaxations come out of queries. The LLM then only
improves the wording. It is the argument to show a prospect: the engine does
not depend on the model's goodwill.

The local provider ignores negation by construction (a bag of words does not
negate). Negation is therefore resolved **upstream**, at parsing time: "pas
trop tannique" produces `descriptors: ['supple']` **and**
`descriptors_excluded: ['tannic']`, and the query vector is
`normalize(v(wanted) − 0.7 · v(rejected))`.

### Running with Claude

```bash
# .env
PSL_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...        # https://console.anthropic.com
PSL_LLM_MODEL=claude-opus-5-5       # default; claude-sonnet-5-5 costs half
```

The key comes from the Claude Console and is billed per use. A Claude Pro or
Max subscription does not cover API calls: it is a separate product.

Measured from the prompt sizes, a search costs about 2,500 to 3,000 input
tokens and 500 to 1,500 output tokens over the two calls, i.e. 2 to 5 euro
cents with Claude Opus 5.5 and half that with Claude Sonnet 5.5. The real cost
of each search is printed by `npm run demo` and logged in the `searches`
table; `PSL_DAILY_BUDGET_EUR` cuts the service off for the day when the sum
reaches it.

Both calls run at `effort: low` and opt into the server-side fallback on
refusal (`fallbacks: "default"`). Whatever still fails (invalid output twice,
refusal, network or key error) falls back on the local parser or the template,
announced as such: the visitor never gets a blank page. `tests/anthropic.test.ts`
runs this provider through the real SDK against a fake HTTP server.

### Stale vectors

Editing `src/config/lexicon.ts` changes how notes are vectorized without
touching the vectors already stored: ranking would keep working, on stale data,
with no signal whatsoever. The `embedding_state` table stores a fingerprint of
the configuration; on a mismatch, the engine **refuses** to rank by vector and
falls back to price. Run `npm run db:embed` again.

---

## Spending guardrails

A public demo without guardrails is the project's only real financial risk.
Three limits, checked **before** any model call (`src/api/guardrails.ts`):

- `PSL_MAX_MESSAGE_LENGTH`: 400 characters;
- `PSL_RATE_LIMIT_PER_IP_PER_HOUR`: 20, on an HMAC of the IP, never the IP;
- `PSL_DAILY_BUDGET_EUR`: shuts the service down for the rest of the day.

The counters live in the `searches` table, which also serves as the demo log:
what the system understood, what it relaxed, what it refused.

---

## Loi Evin

In France, communication about alcoholic beverages is regulated (loi Evin):
objective references are allowed, evocation and incitement are not.

Four leak points were identified and handled:

1. The seed's `rationale` field ("agneau de garrigue", "sans écraser") is
   unsourced editorial prose, in the proscribed register. **It is not
   ingested.**
2. `producer_pairings` copies the estates' marketing prose. It is stored but
   does not feed the formulation.
3. The formulation prompt only quotes named fields and rewords nothing.
4. **The user's message itself.** "Décris-moi ce vin comme une soirée d'été"
   (describe this wine like a summer evening) injects the forbidden register.
   It is the easiest point to miss: the `FormulationInput` type
   (`src/llm/index.ts`) contains neither the message nor the descriptors, and
   `toFormulationInput()` builds the object **field by field**. A spread would
   have left `requestedFilters` physically present in the object handed to the
   model: TypeScript does not check excess properties on a spread, so the
   barrier would only have existed when reading the code.

### One rule, held at both ends

At milestone 5, every note extracted from a PDF must be found **literally** in
its text layer. The same rule applies to the output: every quoted segment in
the model's answer must be a literal substring of a passage provided
(`src/llm/output-check.ts`). Otherwise, the answer is replaced by the template,
which cannot invent anything.

It is exact, with no false positive, and it catches rewording as well as cross
attribution: two things a vocabulary filter lets through. Outside quotation
marks, a check by descriptor family completes it, **scoped per reference**:
globally, three notes covering the lexicon saturated the allowed set and the
check became unable to reject anything.

**This check serves the "no invention" contract, not the loi Evin.** The
lexicon contains no mood words: "une soirée d'été entre amis" goes through.
Better said than hidden.

### The corpus is the real injection vector

The user's request never reaches the formulation prompt. Third-party text
does: at milestone 5, notes will come from PDFs downloaded from sites we do not
control. Three defenses, by value for money:

1. **Reduce the surface.** We send the selected passage, not the whole sheet.
   An injection that must fit in one sentence, pass for a tasting note and
   survive passage selection is hard to write.
2. **Check the quotes** (above).
3. **Quarantine at ingestion** (`src/ingest/quarantine.ts`). A note
   containing what looks like an instruction is flagged for human review, not
   rejected. It is the project's only heuristic filter, and it sits where
   being wrong is cheap: ingestion is offline, rare and supervised. A false
   positive there costs thirty seconds; online it would cost a degraded
   answer.

**The guarantee is architectural with the `local` provider and checked with the
`anthropic` provider.** For a demo whose argument is "the engine does not
depend on the model's goodwill", the template *is* the product; the LLM is a
comfort layer whose output is checked and which falls back on the template at
the slightest doubt. It is defensible and verifiable live.

The interface carries the health warning. An age gate remains to be added if
the demo goes public: it is not authentication, it is twenty lines.

---

## State of the data

**The catalog is real.** 17 wines from 7 estates, collected on 16 September
2026 from the pages published by the producers themselves, each under a
`producer_page` source carrying its URL and date. The reference data lists the
**74 producers** of the appellation, taken from the syndicate's directory. The
details of the collection, including what was left out and why, are in
`ingestion/DATA-COLLECTION-2026-09-16.md`.

The demo therefore runs with **`PSL_ALLOW_FIXTURES=0`**, which was not the case
before: without real data, the whole catalog was a development overlay.

### What is left of the overlay

Two wines from Château de Lancyre. The website alternates between 200s and
failed TLS handshakes, and its shop is a Wix site rendered in JavaScript. They
keep their development values under a `dev_fixture` source, masked field by
field when the flag is 0: the wine stays visible, its description falls back
on the appellation profile, and the interface says so.

Masking applies to the columns, not only to the display: a masked price is
`NULL` and stops being retained by a budget filter. Filtering on a value we
refuse to show would be worse than excluding it. `/api/health` and
`/api/catalog` apply the same predicate.

The masking cases in `tests/search.test.ts` are **visibly disabled**
(`it.skip`) the day `db/seed/wines.fixtures/` disappears, rather than passing
silently on an empty set.

### Three limits to state before showing the demo

**Two pairs of wines carry an identical note.** Dame Jeanne rouge 2022 and
2023 on one side, the two Moja Negra on the other. After checking, the cited
pages are distinct and really carry the same text: the estates reuse their own
copy from one product to the next. The data is therefore honest and sourced,
which is why it is not "fixed". But it has two consequences: their vectors are
identical, so nothing separates them, and out of three results they can take
two places and look like a bug. A screen showing two different wines under the
same description loses the trust it is trying to build; deduplicating on the
note is a product decision, not a fix.

**Alcohol content is missing almost everywhere.** 5 wines out of 17. It is the
field least served by retail sites, and the one that would come from the tech
sheets.

**One vintage to check.** Dame Jeanne rosé is recorded as 2025, the URL of the
cited page contains `...rose-2024...`. Stale slug or misread vintage: it cannot
be settled without reopening the page. Flagged rather than corrected by guess,
since traceability is precisely what is at stake.

### What is still missing

The **PDF tech sheets**. Bergerie du Capucin offers four for download; its
server sends them with `Content-Length: 0`. The milestone 5 measurement bench
therefore still runs on three PDFs made here, and **its 3% rate is worthless**:
measuring an extractor on sheets you produced yourself is circular. The sheets
have to be requested from the estates or picked up at the cellar.

---

## Milestones

| | | |
|---|---|---|
| 1 | Data foundation | done, on a real corpus (17 wines, 74 producers) |
| 2 | Hybrid search without an LLM | done |
| 3 | LLM layer, two calls | Anthropic provider tested offline against a fake HTTP server; not yet run against the live API |
| 4 | Interface | done |
| 5 | Automated PDF ingestion | extractor and measurement bench done, measured on three PDFs made here |

Milestone 5 lives in `ingestion/` (see its README). The contract between the
two languages is set: zod is the single source of truth, `npm run schema:export`
produces from it the JSON Schema committed in `db/schema/`, and `extract.py`
validates its output against it before writing. `tests/schema-export.test.ts`
fails when the committed file is out of date.

Rule to hold: Python's scope stops at "PDF → JSON". As soon as it touches the
database, the embeddings or the API, that is two toolchains to maintain for one
person.

Guardrail: every extracted note must be found **literally** in the PDF's text
layer, checked by string comparison. It is the only place in the pipeline where
a hallucination would go unnoticed.

**The bench's figure is worthless for now.** The three test sheets were made
here, so measuring the extractor on them is circular. The bench is the
deliverable; the rate will only be meaningful on real sheets reviewed by hand.
