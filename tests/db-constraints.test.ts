import { afterAll, describe, expect, it } from 'vitest';
import { db, closeDb } from '../src/db/client.js';

// Asserting on SQLSTATE and constraint name, never on the message: Postgres
// localizes its messages (lc_messages), and "foreign key constraint" does not
// appear on a French server.
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

/**
 * The guarantees of the behavior contract (§3 of the brief) are enforced as
 * Postgres constraints, not as prompt instructions. These tests check that the
 * database itself rejects the forbidden states: that is what makes the "no
 * invention" promise demonstrable in front of a prospect.
 */
describe('database guardrails', () => {
  afterAll(async () => { await closeDb(); });

  it('rejects a white wine in an appellation that does not cover whites', async () => {
    await expect(
      db().query(
        `INSERT INTO wines (id, producer_id, appellation_id, color, name, embedding_level)
         VALUES ('test-white','mas-bruguiere','aoc-pic-saint-loup','white','Test','appellation')`,
      ),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'wines_appellation_id_color_fkey' });
  });

  it('rejects a tasting note without a citable source', async () => {
    await expect(
      db().query(
        `UPDATE wines SET tasting_note_source_id = NULL
          WHERE tasting_note IS NOT NULL`,
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'note_requires_source' });
  });

  it('rejects a price without the date it was observed', async () => {
    await expect(
      db().query(`UPDATE wines SET price_as_of = NULL WHERE price_eur IS NOT NULL`),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'price_requires_date' });
  });

  it('rejects a description level inconsistent with the presence of the note', async () => {
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO wines (id, producer_id, appellation_id, color, name, embedding_level)
         VALUES ('test-level','mas-bruguiere','aoc-pic-saint-loup','red','Test','appellation')`,
      );
      // Claiming to describe the wine while no note describes it.
      await expect(
        client.query(`UPDATE wines SET embedding_level = 'wine' WHERE id = 'test-level'`),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'level_consistent' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('forbids promoting a food pairing to source data', async () => {
    await expect(
      db().query(`UPDATE appellation_pairings SET status = 'source'`),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'appellation_pairings_status_check' });
  });

  it('every wine described at wine level carries a source', async () => {
    const { rows } = await db().query(
      `SELECT count(*)::int AS n FROM wines
        WHERE embedding_level = 'wine' AND tasting_note_source_id IS NULL`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('vector search stays exact, without an index, at this volume', async () => {
    const { rows } = await db().query(
      `EXPLAIN (FORMAT JSON) SELECT id FROM wines WHERE embedding IS NOT NULL
        ORDER BY embedding <=> (SELECT embedding FROM wines WHERE embedding IS NOT NULL LIMIT 1)
        LIMIT 3`,
    );
    const plan = JSON.stringify(rows[0]['QUERY PLAN']);
    // No vector index at this volume: a seq scan is exact and instantaneous.
    expect(plan).not.toMatch(/ivfflat|Index Scan using wines_embedding_idx/);
  });
});
