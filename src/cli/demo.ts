import { closeDb } from '../db/client.js';
import { runPipeline } from '../pipeline.js';
import { activeFilters } from '../schema/filters.js';

const message = process.argv.slice(2).join(' ');
if (!message) {
  console.error('usage: npm run demo -- "un rouge pas trop tannique pour un gigot, autour de 20 euros"');
  process.exit(1);
}

const output = await runPipeline({ message });

const dim = (label: string) => `\x1b[2m${label}\x1b[0m`;

console.log('\n' + dim('> ' + message) + '\n');
console.log(output.text);
console.log('\n' + dim('---'));
console.log(dim('status         :'), output.status);
console.log(dim('LLM provider   :'), output.llmProvider + (output.degraded ? ` (DEGRADED: ${output.degradedReason})` : ''));
console.log(dim('ranking        :'), output.search?.ranking ?? '-');
if (output.search) {
  const f = output.search.appliedFilters;
  console.log(dim('active filters :'), activeFilters(f).map((k) => `${k}=${JSON.stringify((f as any)[k])}`).join('  '));
  if (output.search.relaxations.length) {
    console.log(dim('relaxations    :'), output.search.relaxations.map((r) => r.announcement).join(' | '));
  }
}
console.log(dim('latency        :'), output.latency_ms + ' ms');
console.log(dim('cost           :'), output.usage.cost_eur.toFixed(6) + ' EUR');

await closeDb();
