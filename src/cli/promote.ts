import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCatalog, WINES_DIR } from '../collect/catalog.js';
import { reviewCandidate } from '../collect/review.js';

/**
 * npm run collect:promote -- <candidate.json>... | <candidates folder>
 *                             [--set appellation_id=aoc-languedoc] [--set color=white]
 *
 * The only way into db/seed/wines/: the reviewed candidate is checked again
 * (schema, known producer and grapes, designation and color, AOC grape rules,
 * duplicates, note copied verbatim from the page, quarantine), then written
 * without its review block.
 */
const { values: options, positionals: args } = parseArgs({
  allowPositionals: true,
  options: { set: { type: 'string', multiple: true } },
});
if (args.length === 0) {
  console.error(
    'usage: npm run collect:promote -- <candidate.json>...\n' +
    '       npm run collect:promote -- <candidates folder>   (every candidate in it)\n' +
    '       ... --set appellation_id=vin-de-france            (fills that field where it is empty)',
  );
  process.exit(1);
}

const catalog = await loadCatalog();

/**
 * A decision the reviewer takes once for many files ("these are all Vins de
 * France"). It only fills the fields the page left empty, and only the two
 * the collector leaves to the reviewer; it is written in each wine's
 * provenance.
 */
const SETTABLE: Record<string, (v: string) => boolean> = {
  appellation_id: (v) => catalog.designations.has(v),
  color: (v) => v === 'red' || v === 'rose' || v === 'white',
};
const decisions: [string, string][] = [];
for (const item of options.set ?? []) {
  const [field, value] = item.split('=') as [string, string | undefined];
  if (!SETTABLE[field] || value === undefined || !SETTABLE[field](value)) {
    console.error(
      `--set ${item}: only appellation_id=<${[...catalog.designations.keys()].join('|')}> ` +
      'or color=<red|rose|white>',
    );
    process.exit(1);
  }
  decisions.push([field, value]);
}

// A folder stands for every candidate it holds.
const files: string[] = [];
for (const arg of args) {
  if ((await stat(arg)).isDirectory()) {
    const names = (await readdir(arg)).filter((f) => f.endsWith('.json')).sort();
    files.push(...names.map((f) => join(arg, f)));
  } else {
    files.push(arg);
  }
}
if (files.length === 0) {
  console.error('no candidate file found.');
  process.exit(1);
}

let failures = 0;

for (const file of files) {
  const { _review: review, ...raw } = JSON.parse(await readFile(file, 'utf8'));
  const applied: string[] = [];
  for (const [field, value] of decisions) {
    if (raw[field] == null) {
      raw[field] = value;
      applied.push(`${field}=${value}`);
    }
  }
  let sourceText: string | null = null;
  if (review?.source_text) {
    try {
      sourceText = (await readFile(join(dirname(file), review.source_text), 'utf8')).replace(/\n$/, '');
    } catch {
      sourceText = null;
    }
  }

  const verdict = reviewCandidate(raw, sourceText, catalog);
  if (verdict.errors.length > 0 || !verdict.wine) {
    failures++;
    console.error(`NOT PROMOTED ${basename(file)}`);
    for (const e of verdict.errors) console.error(`  - ${e}`);
    continue;
  }

  const wine = verdict.wine;
  const provenance =
    `Collected on ${review?.collected_on ?? 'unknown date'} from ${wine.page_url} ` +
    `(${review?.platform ?? 'unknown'} product data) by npm run collect, ` +
    'reviewed by hand and promoted with npm run collect:promote' +
    (applied.length ? ` (set by the reviewer for a batch: ${applied.join(', ')}).` : '.');
  await writeFile(
    join(WINES_DIR, `${wine.id}.json`),
    JSON.stringify({ _provenance: provenance, ...wine }, null, 2) + '\n',
    'utf8',
  );
  catalog.existing.push(wine);
  // Out of the way of the next run on the same folder.
  const done = join(dirname(file), 'promoted');
  await mkdir(done, { recursive: true });
  await rename(file, join(done, basename(file)));
  if (review?.source_text) {
    await rename(join(dirname(file), review.source_text), join(done, review.source_text)).catch(() => {});
  }
  console.log(`promoted ${wine.id}`);
  for (const w of verdict.warnings) console.log(`  note: ${w}`);
}

if (failures > 0) {
  console.error(`\n${failures} candidate(s) not promoted: complete or delete them, then run this again.`);
}
if (files.length > failures) console.log('\nNext: npm run db:seed && npm run db:embed');
if (failures > 0) process.exit(1);
