import { db, closeDb } from '../db/client.js';
import { env } from '../config/env.js';
import { ingestReference } from '../ingest/reference.js';
import { ingestWines } from '../ingest/wines.js';

const allowFixtures = env.allowFixtures();

const client = await db().connect();
try {
  await client.query('BEGIN');
  const ref = await ingestReference(client);
  const wines = await ingestWines(client, allowFixtures);
  await client.query('COMMIT');

  console.log('reference :', ref);
  console.log('wines     :', { ...wines, quarantine: wines.quarantine.length });

  if (wines.quarantine.length > 0) {
    console.warn(
      `\n  QUARANTINE  ${wines.quarantine.length} note(s) contain what looks like\n` +
      '  an instruction addressed to a system. They are ingested, but MUST BE\n' +
      '  REVIEWED BY HAND before any demo:\n',
    );
    for (const q of wines.quarantine) {
      console.warn(`    ${q.wineId} [${q.patterns.join(', ')}]`);
      console.warn(`      ${q.excerpt}…`);
    }
    console.warn('');
  }

  if (allowFixtures) {
    console.warn(
      '\n  WARNING  PSL_ALLOW_FIXTURES=1\n' +
      `  ${wines.fixturesApplied} wine(s) carry DEVELOPMENT notes, prices and blends,\n` +
      '  not taken from a producer tech sheet.\n' +
      '  Forbidden on a public demo. Set the variable back to 0.\n',
    );
  } else if (wines.onAppellationProfile === wines.wines && wines.wines > 0) {
    console.log(
      '\n  note: no wine carries a sourced tasting note.\n' +
      '  The system will answer from the appellation profile and say so.\n' +
      '  That is the expected behavior until producer sheets are indexed:\n' +
      '  it never fills the gap.\n',
    );
  }
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
  await closeDb();
}
