import { migrer } from '../db/migrate.js';
import { fermer } from '../db/client.js';

const args = new Set(process.argv.slice(2));

const appliquees = await migrer({
  avecIndexVectoriel: args.has('--avec-index-vectoriel'),
  reset: args.has('--reset'),
});

if (appliquees.length === 0) {
  console.log('migrations: rien a appliquer');
} else {
  for (const m of appliquees) console.log(`migrations: ${m}`);
}

if (!args.has('--avec-index-vectoriel')) {
  console.log(
    'note: 900_ivfflat.sql non appliquee (index vectoriel inutile sous ~5 000 lignes).',
  );
}

await fermer();
