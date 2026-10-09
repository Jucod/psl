import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { env } from '../config/env.js';
import { loadCatalog } from '../collect/catalog.js';
import { extractCandidate, type Candidate } from '../collect/extract.js';
import { PoliteFetcher } from '../collect/http.js';
import { estatePage, listProductsFromHtml } from '../collect/html.js';
import { listProducts, type RawProduct } from '../collect/platforms.js';
import { reviewCandidate } from '../collect/review.js';

/**
 * npm run collect [-- --producer <id>[,<id>...]] [--out <dir>] [--max-pages <n>]
 *
 * Reads the shops of the directory's estates, through their public product
 * APIs when they have one (Shopify, WooCommerce), otherwise through the
 * product data of their HTML pages, and writes CANDIDATES for review: nothing
 * here touches db/seed/wines/.
 * See ingestion/README.md, "Collecting more wines".
 */
const { values: args } = parseArgs({
  options: {
    producer: { type: 'string' },
    out: { type: 'string' },
    delay: { type: 'string', default: '1000' },
    'max-pages': { type: 'string', default: '40' },
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

const rows: string[] = [];
const ready: string[] = [];
const toComplete: string[] = [];
const excludedByReason = new Map<string, string[]>();
const noApi: string[] = [];
const byHand: string[] = [];
let products = 0;
let known = 0;

for (const producer of producers) {
  process.stdout.write(`${producer.id.padEnd(44)} `);
  let list: RawProduct[] | null;
  let channel: string;
  try {
    // A shop shared with other estates: its product API would list them all.
    list = estatePage(producer.website) ? null : await listProducts(http, producer.website);
    channel = list?.[0]?.platform ?? 'api';
    if (list === null) {
      const html = await listProductsFromHtml(http, producer.website, Number(args['max-pages']));
      list = html.products;
      channel = `html (${html.via}, ${html.pagesRead} pages)`;
      if (html.withoutData.length > 0) {
        byHand.push(`### ${producer.id}`, '', ...html.withoutData.slice(0, 15).map((u) => `- <${u}>`), '');
      }
      if (list.length === 0) {
        console.log(`no product data (${channel}${html.withoutData.length ? `, ${html.withoutData.length} wine pages to look at by hand` : ''})`);
        noApi.push(`${producer.id} (${producer.website}): ${channel}`);
        continue;
      }
    }
  } catch (e) {
    console.log(`error: ${(e as Error).message}`);
    rows.push(`| ${producer.id} | error: ${(e as Error).message.slice(0, 60)} | | | | | |`);
    continue;
  }

  products += list.length;
  const counts = { ready: 0, toComplete: 0, known: 0, excluded: 0 };
  for (const product of list) {
    const result = extractCandidate(product, producer, catalog, today);
    if (result.kind === 'excluded') {
      counts.excluded++;
      const bucket = excludedByReason.get(result.reason) ?? [];
      bucket.push(`${producer.id}: ${result.title} <${result.url}>`);
      excludedByReason.set(result.reason, bucket);
      continue;
    }
    const verdict = reviewCandidate(result.candidate.wine, result.candidate.sourceText, catalog);
    if (verdict.errors.some((e) => e.startsWith('already in the catalog'))) {
      counts.known++;
      continue;
    }
    await writeCandidate(result.candidate, product.platform, [...verdict.errors, ...verdict.warnings]);
    const { wine, flags, toComplete: missing } = result.candidate;
    const entry = [
      `### ${wine.id}`, '', `<${wine.page_url}>`, '',
      ...missing.map((m) => `- **to complete**: ${m}`),
      ...flags.map((f) => `- ${f}`), '',
    ];
    if (missing.length > 0) {
      counts.toComplete++;
      toComplete.push(...entry);
    } else {
      counts.ready++;
      ready.push(...entry);
    }
  }
  known += counts.known;
  console.log(
    `${channel}: ${list.length} products → ${counts.ready} ready, ` +
    `${counts.toComplete} to complete, ${counts.known} known, ${counts.excluded} excluded`,
  );
  rows.push(
    `| ${producer.id} | ${channel} | ${list.length} | ${counts.ready} | ` +
    `${counts.toComplete} | ${counts.known} | ${counts.excluded} |`,
  );
}

const readyCount = ready.filter((l) => l.startsWith('### ')).length;
const completeCount = toComplete.filter((l) => l.startsWith('### ')).length;
const excludedCount = [...excludedByReason.values()].reduce((n, v) => n + v.length, 0);

const report = [
  `# Collection of ${today}`,
  '',
  `${products} products read on ${producers.length - noApi.length} shops: ` +
  `**${readyCount} ready**, **${completeCount} to complete**, ${known} already in the catalog, ` +
  `${excludedCount} excluded. ${noApi.length} websites gave no product data.`,
  '',
  '"To complete" candidates leave the designation or the color empty because the page does not',
  'settle it: set the field in the JSON file, or delete the file. Promotion refuses them until then.',
  '',
  '| producer | shop | products | ready | to complete | known | excluded |',
  '|---|---|---|---|---|---|---|',
  ...rows,
  '',
  '## Excluded, by reason',
  '',
  ...[...excludedByReason].sort((a, b) => b[1].length - a[1].length)
    .map(([reason, items]) => `- ${items.length} × ${reason}`),
  '',
  `## Ready (${readyCount})`, '', ...ready,
  `## To complete (${completeCount})`, '', ...toComplete,
  `## Excluded (${excludedCount})`, '',
  ...[...excludedByReason].flatMap(([reason, items]) => [`### ${reason}`, '', ...items.map((i) => `- ${i}`), '']),
  `## Websites without product data (${noApi.length})`, '',
  'Neither a product API nor schema.org product data on their pages: their wines need a browser,',
  'a parser written for the site, or the PDF tech sheets.', '',
  ...noApi.map((p) => `- ${p}`), '',
  '## Wine pages without product data, to look at by hand', '',
  'Pages whose address looks like a wine but which carry no structured product data. They are',
  'not read automatically, so that nothing is guessed from a page layout.', '',
  ...byHand,
];
await writeFile(join(outDir, 'REPORT.md'), report.join('\n'), 'utf8');

const shown = relative(process.cwd(), outDir).replaceAll('\\', '/');
console.log(
  `\n${readyCount} ready, ${completeCount} to complete, ${known} already in the catalog, ` +
  `${excludedCount} excluded, ${noApi.length} websites without product data.\n` +
  [...excludedByReason].sort((a, b) => b[1].length - a[1].length)
    .map(([reason, items]) => `  excluded ${String(items.length).padStart(3)} × ${reason}`).join('\n') +
  `\n\nNext:\n` +
  `  1. read ${shown}/REPORT.md; complete or delete the "to complete" files\n` +
  `  2. npm run collect:promote -- ${shown}\n` +
  '  3. npm run db:seed && npm run db:embed',
);

async function writeCandidate(candidate: Candidate, platform: string, checks: string[]): Promise<void> {
  const { wine, flags, toComplete: missing, sourceText } = candidate;
  await writeFile(join(outDir, `${wine.id}.source.txt`), sourceText + '\n', 'utf8');
  await writeFile(
    join(outDir, `${wine.id}.json`),
    JSON.stringify({
      _review: {
        collected_on: today,
        platform,
        source_text: `${wine.id}.source.txt`,
        to_complete: missing,
        flags,
        checks,
      },
      ...wine,
    }, null, 2) + '\n',
    'utf8',
  );
}
