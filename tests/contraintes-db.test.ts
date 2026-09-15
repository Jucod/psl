import { afterAll, describe, expect, it } from 'vitest';
import { db, fermer } from '../src/db/client.js';

/**
 * Les garanties du contrat de comportement (§3 du brief) sont posees en
 * contraintes Postgres, pas en consignes de prompt. Ces tests verifient que la
 * base refuse elle-meme les etats interdits: c'est ce qui rend la promesse
 * "aucune invention" demontrable devant un prospect.
 */
describe('garde-fous de la base', () => {
  afterAll(async () => { await fermer(); });

  it('refuse un blanc dans une appellation qui ne couvre pas les blancs', async () => {
    await expect(
      db().query(
        `INSERT INTO cuvees (id, domaine_id, appellation_id, couleur, nom_cuvee, embedding_niveau)
         VALUES ('test-blanc','mas-bruguiere','aoc-pic-saint-loup','blanc','Test','appellation')`,
      ),
    ).rejects.toThrow(/foreign key constraint/i);
  });

  it('refuse une note de degustation sans source citable', async () => {
    await expect(
      db().query(
        `UPDATE cuvees SET note_degustation_source_id = NULL
          WHERE note_degustation IS NOT NULL`,
      ),
    ).rejects.toThrow(/note_exige_source/);
  });

  it('refuse un prix sans date de releve', async () => {
    await expect(
      db().query(`UPDATE cuvees SET prix_date_releve = NULL WHERE prix_ttc IS NOT NULL`),
    ).rejects.toThrow(/prix_exige_date/);
  });

  it('refuse un niveau de description incoherent avec la presence de la note', async () => {
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO cuvees (id, domaine_id, appellation_id, couleur, nom_cuvee, embedding_niveau)
         VALUES ('test-niveau','mas-bruguiere','aoc-pic-saint-loup','rouge','Test','appellation')`,
      );
      // Pretendre decrire la cuvee alors qu'aucune note ne la decrit.
      await expect(
        client.query(`UPDATE cuvees SET embedding_niveau = 'cuvee' WHERE id = 'test-niveau'`),
      ).rejects.toThrow(/niveau_coherent/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('interdit de promouvoir un accord mets-vins en donnee source', async () => {
    await expect(
      db().query(`UPDATE appellation_accords SET statut = 'source'`),
    ).rejects.toThrow(/appellation_accords_statut_check|check constraint/i);
  });

  it('chaque cuvee decrite au niveau cuvee porte une source', async () => {
    const { rows } = await db().query(
      `SELECT count(*)::int AS n FROM cuvees
        WHERE embedding_niveau = 'cuvee' AND note_degustation_source_id IS NULL`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('la recherche vectorielle reste exacte, sans index, a ce volume', async () => {
    const { rows } = await db().query(
      `EXPLAIN (FORMAT JSON) SELECT id FROM cuvees WHERE embedding IS NOT NULL
        ORDER BY embedding <=> (SELECT embedding FROM cuvees WHERE embedding IS NOT NULL LIMIT 1)
        LIMIT 3`,
    );
    const plan = JSON.stringify(rows[0]['QUERY PLAN']);
    // Pas d'index vectoriel a ce volume: un seq scan est exact et instantane.
    expect(plan).not.toMatch(/ivfflat|Index Scan using cuvees_embedding_idx/);
  });
});
