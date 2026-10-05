import { migrate } from '../db/migrate.js';
import { closeDb } from '../db/client.js';

const args = new Set(process.argv.slice(2));

const applied = await migrate({
  withVectorIndex: args.has('--with-vector-index'),
  reset: args.has('--reset'),
});

if (applied.length === 0) {
  console.log('migrations: nothing to apply');
} else {
  for (const m of applied) console.log(`migrations: ${m}`);
}

if (!args.has('--with-vector-index')) {
  console.log(
    'note: 900_ivfflat.sql not applied (a vector index is useless below ~5,000 rows).',
  );
}

await closeDb();
