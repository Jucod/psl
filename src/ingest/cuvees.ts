import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { CuveeSchema, type Cuvee } from '../schema/cuvee.js';
import { codeCepage, construireIndexCepages } from './util.js';

const DOSSIER_BASE = new URL('../../db/seed/cuvees/', import.meta.url).pathname;
const DOSSIER_FIXTURES = new URL('../../db/seed/cuvees.fixtures/', import.meta.url).pathname;
const CHEMIN_CEPAGES = new URL('../../db/seed/cepages.json', import.meta.url).pathname;

export interface ResultatCuvees {
  cuvees: number;
  avecNoteProducteur: number;
  surProfilAppellation: number;
  fixturesAppliquees: number;
  assemblages: number;
}

async function lireDossier(dossier: string): Promise<Record<string, any>[]> {
  let fichiers: string[];
  try {
    fichiers = (await readdir(dossier)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return Promise.all(
    fichiers.sort().map(async (f) => JSON.parse(await readFile(join(dossier, f), 'utf8'))),
  );
}

/**
 * Charge les cuvees. Les fichiers de db/seed/cuvees/ ne portent que ce qui a pu
 * etre source. db/seed/cuvees.fixtures/ est un CALQUE qui remplit les champs
 * manquants (note, prix, assemblage) avec des valeurs de developpement, sous une
 * source de type `fixture_dev`.
 *
 * Le calque n'est applique que si autoriserFixtures est vrai. Sinon, les cuvees
 * restent depourvues de note et le systeme repond depuis le profil
 * d'appellation en l'annonçant, ce qui est le comportement attendu par le §3
 * du brief: il ne comble jamais le vide.
 */
export async function chargerCuvees(autoriserFixtures: boolean): Promise<{
  cuvees: Cuvee[];
  fixturesAppliquees: number;
}> {
  const base = await lireDossier(DOSSIER_BASE);
  const calques = autoriserFixtures ? await lireDossier(DOSSIER_FIXTURES) : [];
  const parId = new Map(calques.map((c) => [c.id as string, c]));

  let fixturesAppliquees = 0;
  const cuvees = base.map((brut) => {
    const calque = parId.get(brut.id);
    const fusion: Record<string, any> = { ...brut };
    delete fusion._provenance;

    if (calque) {
      fixturesAppliquees++;
      for (const [cle, valeur] of Object.entries(calque)) {
        if (cle.startsWith('_') || cle === 'id') continue;
        fusion[cle] = valeur;
      }
    }

    const parsed = CuveeSchema.safeParse(fusion);
    if (!parsed.success) {
      throw new Error(
        `cuvee ${brut.id} invalide: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
    }
    return parsed.data;
  });

  return { cuvees, fixturesAppliquees };
}

export async function ingererCuvees(
  client: pg.PoolClient,
  autoriserFixtures: boolean,
): Promise<ResultatCuvees> {
  const cepagesDoc = JSON.parse(await readFile(CHEMIN_CEPAGES, 'utf8'));
  const indexCepages = construireIndexCepages(cepagesDoc.cepages);

  const { cuvees, fixturesAppliquees } = await chargerCuvees(autoriserFixtures);

  const res: ResultatCuvees = {
    cuvees: 0, avecNoteProducteur: 0, surProfilAppellation: 0,
    fixturesAppliquees, assemblages: 0,
  };

  for (const c of cuvees) {
    let sourceNoteId: string | null = null;
    if (c.note_degustation_source) {
      const s = c.note_degustation_source;
      await client.query(
        `INSERT INTO sources (id, type, label, url, autorite, date_releve)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET
           type=EXCLUDED.type, label=EXCLUDED.label, url=EXCLUDED.url,
           date_releve=EXCLUDED.date_releve`,
        [s.id, s.type, s.label, s.url, s.autorite ?? null, s.date_releve],
      );
      sourceNoteId = s.id;
    }

    // Separation des niveaux, materialisee en base. La note du producteur est
    // embeddee SEULE. En son absence on ne fabrique rien: la cuvee est marquee
    // 'appellation' et la recherche retombera sur le profil AOC, en l'annonçant.
    const niveau = c.note_degustation ? 'cuvee' : 'appellation';
    const embeddingSource = c.note_degustation;

    await client.query(
      `INSERT INTO cuvees
         (id, domaine_id, appellation_id, couleur, nom_cuvee, millesime, degre,
          elevage, prix_ttc, prix_date_releve, bio, certification,
          note_degustation, note_degustation_source_id, accords_producteur,
          embedding_source, embedding_niveau, fiche_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (id) DO UPDATE SET
         domaine_id=EXCLUDED.domaine_id, appellation_id=EXCLUDED.appellation_id,
         couleur=EXCLUDED.couleur, nom_cuvee=EXCLUDED.nom_cuvee,
         millesime=EXCLUDED.millesime, degre=EXCLUDED.degre,
         elevage=EXCLUDED.elevage, prix_ttc=EXCLUDED.prix_ttc,
         prix_date_releve=EXCLUDED.prix_date_releve, bio=EXCLUDED.bio,
         certification=EXCLUDED.certification,
         note_degustation=EXCLUDED.note_degustation,
         note_degustation_source_id=EXCLUDED.note_degustation_source_id,
         accords_producteur=EXCLUDED.accords_producteur,
         embedding_source=EXCLUDED.embedding_source,
         embedding_niveau=EXCLUDED.embedding_niveau,
         fiche_url=EXCLUDED.fiche_url,
         updated_at=now()`,
      [c.id, c.domaine_id, c.appellation_id, c.couleur, c.nom_cuvee, c.millesime,
       c.degre, c.elevage, c.prix_ttc, c.prix_date_releve, c.bio, c.certification,
       c.note_degustation, sourceNoteId, c.accords_producteur,
       embeddingSource, niveau, c.fiche_url],
    );

    res.cuvees++;
    if (niveau === 'cuvee') res.avecNoteProducteur++;
    else res.surProfilAppellation++;

    await client.query('DELETE FROM cuvee_cepages WHERE cuvee_id = $1', [c.id]);
    for (const a of c.assemblage) {
      const code = codeCepage(a.cepage, indexCepages);
      if (!code) {
        throw new Error(
          `cuvee ${c.id}: cepage inconnu "${a.cepage}". Ajoute-le a db/seed/cepages.json ` +
          `plutot que de le laisser passer: un cepage non normalise fait rater un filtre en silence.`,
        );
      }
      await client.query(
        `INSERT INTO cuvee_cepages (cuvee_id, cepage, pct) VALUES ($1,$2,$3)
         ON CONFLICT (cuvee_id, cepage) DO UPDATE SET pct=EXCLUDED.pct`,
        [c.id, code, a.pct],
      );
      res.assemblages++;
    }
  }

  return res;
}
