import { db, fermer } from '../db/client.js';
import { env } from '../config/env.js';
import { ingererReferentiel } from '../ingest/referentiel.js';
import { ingererCuvees } from '../ingest/cuvees.js';

const autoriserFixtures = env.autoriserFixtures();

const client = await db().connect();
try {
  await client.query('BEGIN');
  const ref = await ingererReferentiel(client);
  const cuv = await ingererCuvees(client, autoriserFixtures);
  await client.query('COMMIT');

  console.log('referentiel :', ref);
  console.log('cuvees      :', { ...cuv, quarantaine: cuv.quarantaine.length });

  if (cuv.quarantaine.length > 0) {
    console.warn(
      `\n  QUARANTAINE  ${cuv.quarantaine.length} note(s) contiennent ce qui\n` +
      '  ressemble a une instruction adressee a un systeme. Elles sont ingerees,\n' +
      '  mais A RELIRE A LA MAIN avant toute demo:\n',
    );
    for (const q of cuv.quarantaine) {
      console.warn(`    ${q.cuvee_id} [${q.motifs.join(', ')}]`);
      console.warn(`      ${q.extrait}…`);
    }
    console.warn('');
  }

  if (autoriserFixtures) {
    console.warn(
      '\n  ATTENTION  PSL_AUTORISER_FIXTURES=1\n' +
      `  ${cuv.fixturesAppliquees} cuvee(s) portent des notes, prix et assemblages de\n` +
      '  DEVELOPPEMENT, non releves sur une fiche technique de producteur.\n' +
      '  Interdit sur une demo publique. Remets la variable a 0.\n',
    );
  } else if (cuv.surProfilAppellation === cuv.cuvees && cuv.cuvees > 0) {
    console.log(
      '\n  note: aucune cuvee ne porte de note de degustation sourcee.\n' +
      '  Le systeme repondra depuis le profil d appellation en l annonçant.\n' +
      '  C est le comportement attendu tant que les fiches producteurs ne sont\n' +
      '  pas indexees: il ne comble jamais le vide.\n',
    );
  }
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
  await fermer();
}
