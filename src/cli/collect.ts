import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { env } from '../config/env.js';
import { loadCatalog } from '../collect/catalog.js';
import { extractCandidate, type Candidate } from '../collect/extract.js';
import { PoliteFetcher } from '../collect/http.js';
import { listProducts } from '../collect/platforms.js';
import { reviewCandidate } from '../collect/review.js';

/**
 * npm run collect [-- --producer <id>[,<id>...]] [--out <dir>]
 *
 * Reads the shops of the directory's estates through their public product
 * APIs and writes CANDIDATES for review: nothing here touches db/seed/wines/.
 * See ingestion/README.md, "Collecting more wines".
 */
const { values: args } = parseArgs({
  options: {
    producer: { type: 'string' },
    out: { type: 'string' },
    delay: { type: 'string', default: '1000' },
  },
});

const contact = env.collectContact();
if (!contact) {
  console.error(
    'PSL_COLLECT_CONTACT is empty. Set it to an e-mail or a URL in .env: the collector\n' +
    'identifies itself to the estates\' websites, so that they can reach you.',
  );
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const root = fileURLToPath(new URL('../../', import.meta.url));
const outDir = args.out ?? join(root, 'ingestion', 'candidates', today);
await mkdir(outDir, { recursive: true });

const catalog = await loadCatalog();
const wanted = args.producer?.split(',').map((s) => s.trim());
const producers = wanted ? catalog.producers.filter((p) => wanted.includes(p.id)) : catalog.producers;
if (wanted && producers.length !== wanted.length) {
  const known = new Set(producers.map((p) => p.id));
  console.error(`unknown or website-less producer(s): ${wanted.filter((w) => !known.has(w)).join(', ')}`);
  process.exit(1);
}

const http = new PoliteFetcher({
  userAgent: `psl-catalog-research/0.1 (+${contact})`,
  delayMs: Number(args.delay),
});

const report: string[] = [
  `# Collection of ${today}`,
  '',
  'Candidates only. Review each file, fix or delete it, then promote with',
  '`npm run collect:promote -- <file>...` (see ingestion/README.md).',
  '',
  '| producer | shop | products | candidates | already in catalog | excluded |',
  '|---|---|---|---|---|---|',
];
const details: string[] = [];
let total = 0;

for (const producer of producers) {
  process.stdout.write(`${producer.id.padEnd(44)} `);
  let products;
  try {
    products = await listProducts(http, producer.website);
  } catch (e) {
    console.log(`error: ${(e as Error).message}`);
    report.push(`| ${producer.id} | error: ${(e as Error).message.slice(0, 60)} | | | | |`);
    continue;
  }
  if (products === null) {
    console.log('no public product API');
    report.push(`| ${producer.id} | no public product API | | | | |`);
    continue;
  }

  const candidates: Candidate[] = [];
  const excluded: string[] = [];
  let known = 0;
  for (const product of products) {
    const result = extractCandidate(product, producer, catalog.grapeIndex, today);
    if (result.kind === 'excluded') {
      excluded.push(`${result.title}: ${result.reason}`);
      continue;
    }
    const verdict = reviewCandidate(result.candidate.wine, result.candidate.sourceText, catalog);
    if (verdict.errors.some((e) => e.startsWith('already in the catalog'))) {
      known++;
      continue;
    }
    candidates.push(result.candidate);
    const { wine, flags, sourceText } = result.candidate;
    await writeFile(join(outDir, `${wine.id}.source.txt`), sourceText + '\n', 'utf8');
    await writeFile(
      join(outDir, `${wine.id}.json`),
      JSON.stringify({
        _review: {
          collected_on: today,
          platform: products[0]!.platform,
          source_text: `${wine.id}.source.txt`,
          flags,
          checks: [...verdict.errors, ...verdict.warnings],
        },
        ...wine,
      }, null, 2) + '\n',
      'utf8',
    );
    details.push(
      `### ${wine.id}`, '', `<${wine.page_url}>`, '',
      ...[...flags, ...verdict.errors, ...verdict.warnings].map((f) => `- ${f}`), '',
    );
  }
  total += candidates.length;
  console.log(`${products[0]?.platform ?? '-'}: ${products.length} products, ${candidates.length} candidates, ${known} known`);
  report.push(`| ${producer.id} | ${products[0]?.platform ?? '-'} | ${products.length} | ${candidates.length} | ${known} | ${excluded.length} |`);
  if (excluded.length) details.push(`### ${producer.id}: excluded`, '', ...excluded.map((e) => `- ${e}`), '');
}

report.push('', `**${total} candidate(s).**`, '', '## Details', '', ...details);
await writeFile(join(outDir, 'REPORT.md'), report.join('\n') + '\n', 'utf8');
const shown = relative(process.cwd(), outDir).replaceAll('\\', '/');
console.log(
  `\n${total} candidate(s) in ${shown}/\n\n` +
  'Next:\n' +
  `  1. read ${shown}/REPORT.md, then fix or delete the candidate files\n` +
  `  2. npm run collect:promote -- ${shown}\n` +
  '  3. npm run db:seed && npm run db:embed',
);
