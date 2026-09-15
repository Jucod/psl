import type pg from 'pg';
import { champParCle, config } from '../config/domaine.js';
import { PLATS } from '../config/lexique.js';
import { db, versVecteur } from '../db/client.js';
import type { Filtres } from '../schema/filtres.js';
import { construireClauses } from './requete.js';
import { fournisseurEmbedding } from '../embeddings/index.js';
import { verifierSignature } from '../embeddings/signature.js';
import type {
  AccordDerive, Relachement, Resultat, ResultatRecherche, SourceCitee,
} from './types.js';

export interface OptionsRecherche {
  /** Vecteur de la partie floue de la demande. null = classement lexicographique. */
  vecteurRequete?: number[] | null;
  autoriserFixtures?: boolean;
  pool?: pg.Pool;
  /** Garde-fou de boucle. Une iteration = un cran de relachement. */
  maxIterations?: number;
}

const SQL_RESULTATS = `
  SELECT
    c.id, c.nom_cuvee, c.appellation_id, c.couleur, c.millesime, c.degre,
    c.elevage, c.prix_ttc, c.prix_date_releve::text AS prix_date_releve,
    c.bio, c.certification, c.note_degustation, c.accords_producteur,
    c.fiche_url, c.embedding_niveau,
    d.id AS domaine_id, d.nom AS domaine, d.commune,
    sn.id  AS ns_id,  sn.type AS ns_type, sn.label AS ns_label,
    sn.url AS ns_url, sn.autorite AS ns_autorite, sn.date_releve::text AS ns_date,
    p.texte_profil, p.source_section,
    sp.id  AS ps_id,  sp.type AS ps_type, sp.label AS ps_label,
    sp.url AS ps_url, sp.autorite AS ps_autorite, sp.date_releve::text AS ps_date,
    COALESCE((
      SELECT json_agg(json_build_object('cepage', cc.cepage, 'pct', cc.pct)
                      ORDER BY cc.pct DESC NULLS LAST, cc.cepage)
      FROM cuvee_cepages cc WHERE cc.cuvee_id = c.id
    ), '[]'::json) AS assemblage,
    CASE
      WHEN $1::vector IS NULL THEN NULL
      ELSE 1 - (COALESCE(c.embedding, p.embedding) <=> $1::vector)
    END AS score
  FROM cuvees c
  JOIN domaines d ON d.id = c.domaine_id
  LEFT JOIN appellation_profils p
         ON p.appellation_id = c.appellation_id AND p.couleur = c.couleur
  LEFT JOIN sources sn ON sn.id = c.note_degustation_source_id
  LEFT JOIN sources sp ON sp.id = p.source_id
  WHERE c.disponible
    -- Double verrou: meme si des fixtures ont ete ingerees, le service refuse
    -- de les servir quand le flag est a false au moment de la requete.
    AND ($2::boolean OR sn.type IS DISTINCT FROM 'fixture_dev')
    AND `;

function source(
  r: Record<string, any>, prefixe: 'ns' | 'ps',
): SourceCitee | null {
  const id = r[`${prefixe}_id`];
  if (!id) return null;
  return {
    id,
    type: r[`${prefixe}_type`],
    label: r[`${prefixe}_label`],
    url: r[`${prefixe}_url`],
    autorite: r[`${prefixe}_autorite`] ?? null,
    date_releve: r[`${prefixe}_date`],
  };
}

function versResultat(r: Record<string, any>): Resultat {
  const noteSource = source(r, 'ns');
  const profilSource = source(r, 'ps');
  return {
    id: r.id,
    nom_cuvee: r.nom_cuvee,
    domaine: r.domaine,
    domaine_id: r.domaine_id,
    commune: r.commune ?? null,
    appellation_id: r.appellation_id,
    couleur: r.couleur,
    millesime: r.millesime ?? null,
    degre: r.degre ?? null,
    elevage: r.elevage ?? null,
    prix_ttc: r.prix_ttc ?? null,
    prix_date_releve: r.prix_date_releve ?? null,
    bio: r.bio ?? null,
    certification: r.certification ?? null,
    assemblage: r.assemblage ?? [],
    fiche_url: r.fiche_url ?? null,
    note_degustation: r.note_degustation ?? null,
    note_source: noteSource,
    accords_producteur: r.accords_producteur ?? [],
    niveau: r.embedding_niveau,
    profil_appellation:
      r.texte_profil && profilSource
        ? { texte: r.texte_profil, source: profilSource, section: r.source_section ?? null }
        : null,
    score: r.score === null || r.score === undefined ? 0 : Number(r.score),
    fixture: noteSource?.type === 'fixture_dev',
  };
}

async function executer(
  pool: pg.Pool,
  filtres: Filtres,
  vecteur: number[] | null,
  autoriserFixtures: boolean,
): Promise<Resultat[]> {
  const { texte, params } = construireClauses(filtres, 3);
  const sql =
    SQL_RESULTATS + `(${texte})\n` +
    `  ORDER BY score DESC NULLS LAST, c.prix_ttc ASC NULLS LAST, c.id\n` +
    `  LIMIT ${config.maxResultats}`;

  const { rows } = await pool.query(sql, [
    vecteur ? versVecteur(vecteur) : null,
    autoriserFixtures,
    ...params,
  ]);
  return rows.map(versResultat);
}

/**
 * Verifie que la combinaison demandee est couverte par le catalogue au niveau
 * du referentiel. C'est une REQUETE, pas une consigne de prompt: le refus d'un
 * blanc en Pic Saint-Loup est reproductible et testable sans appel LLM.
 */
async function verifierCouverture(
  pool: pg.Pool,
  filtres: Filtres,
): Promise<{ message: string; source: SourceCitee | null } | null> {
  const { table, cles, message } = config.couverture;
  const valeurs: Record<string, unknown> = {};
  for (const { filtre } of cles) {
    const v = (filtres as Record<string, unknown>)[filtre];
    if (v === null || v === undefined) return null; // rien a verifier
    valeurs[filtre] = v;
  }

  const conditions = cles.map((c, i) => `${c.colonne} = $${i + 1}`).join(' AND ');
  const params = cles.map((c) => valeurs[c.filtre]);

  const { rowCount } = await pool.query(`SELECT 1 FROM ${table} WHERE ${conditions}`, params);
  if (rowCount && rowCount > 0) return null;

  // La combinaison n'existe pas. On dit ce qui existe, on ne propose pas
  // d'approchant.
  const cleDiscriminante = cles[cles.length - 1]!;
  const autres = cles.slice(0, -1);
  const { rows } = await pool.query(
    `SELECT ${cleDiscriminante.colonne} AS v FROM ${table}
      WHERE ${autres.map((c, i) => `${c.colonne} = $${i + 1}`).join(' AND ') || 'TRUE'}
      ORDER BY 1`,
    autres.map((c) => valeurs[c.filtre]),
  );
  const disponibles = rows.map((r) => String(r.v));
  if (disponibles.length === 0) return null; // appellation inconnue: pas un refus de couverture

  const { rows: src } = await pool.query(
    `SELECT s.id, s.type, s.label, s.url, s.autorite, s.date_releve::text
       FROM appellations a JOIN sources s ON s.id = a.source_id
      WHERE a.id = $1`,
    [valeurs[cles[0]!.filtre]],
  );

  return {
    message: message(valeurs, disponibles),
    source: src[0]
      ? { ...src[0], autorite: src[0].autorite ?? null } as SourceCitee
      : null,
  };
}

async function accordsPourLePlat(
  pool: pg.Pool, filtres: Filtres,
): Promise<AccordDerive[]> {
  if (!filtres.plat || !filtres.appellation || !filtres.couleur) return [];
  const categorie = PLATS[filtres.plat]?.categorie;
  if (!categorie) return [];

  const { rows } = await pool.query(
    `SELECT libelle, categorie, statut, derive_de FROM appellation_accords
      WHERE appellation_id = $1 AND couleur = $2 AND categorie = $3
      ORDER BY libelle`,
    [filtres.appellation, filtres.couleur, categorie],
  );
  return rows as AccordDerive[];
}

async function tailleCatalogue(
  pool: pg.Pool, filtres: Filtres, autoriserFixtures: boolean,
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM cuvees c
       LEFT JOIN sources sn ON sn.id = c.note_degustation_source_id
      WHERE c.disponible
        AND ($3::boolean OR sn.type IS DISTINCT FROM 'fixture_dev')
        AND ($1::text IS NULL OR c.appellation_id = $1)
        AND ($2::text IS NULL OR c.couleur = $2)`,
    [filtres.appellation, filtres.couleur, autoriserFixtures],
  );
  return rows[0]!.n as number;
}

export async function rechercher(
  filtres: Filtres,
  options: OptionsRecherche = {},
): Promise<ResultatRecherche> {
  const pool = options.pool ?? db();
  const autoriserFixtures = options.autoriserFixtures ?? false;
  const maxIterations = options.maxIterations ?? 12;
  const avertissements: string[] = [];

  // Les vecteurs stockes ont-ils ete calcules avec la configuration courante ?
  // Sinon on refuse de classer au vectoriel: un ordre faux qui a l'air correct
  // coute plus cher qu'un classement par prix assume.
  let vecteur = options.vecteurRequete ?? null;
  if (vecteur) {
    const etat = await verifierSignature(pool, fournisseurEmbedding());
    if (!etat.aJour) {
      avertissements.push(etat.message!);
      vecteur = null;
    }
  }

  const base: ResultatRecherche = {
    statut: 'vide',
    refus: null,
    filtresDemandes: filtres,
    filtresAppliques: filtres,
    relachements: [],
    classement: vecteur ? 'vectoriel' : 'lexicographique',
    resultats: [],
    accordsPourLePlat: [],
    tailleCatalogue: 0,
    avertissements,
  };

  // 1. Le catalogue peut-il, par construction, contenir ce qui est demande ?
  const refus = await verifierCouverture(pool, filtres);
  if (refus) return { ...base, statut: 'refus_hors_catalogue', refus };

  base.tailleCatalogue = await tailleCatalogue(pool, filtres, autoriserFixtures);
  base.accordsPourLePlat = await accordsPourLePlat(pool, filtres);

  // 2. Recherche, puis elargissement UNE contrainte a la fois.
  const origine = { ...filtres } as Record<string, any>;
  let courants = { ...filtres } as Record<string, any>;
  const relachements: Relachement[] = [];

  for (let i = 0; i <= maxIterations; i++) {
    const resultats = await executer(pool, courants as Filtres, vecteur, autoriserFixtures);

    if (resultats.length > 0) {
      // Si la partie floue ne correspond a rien, on le dit plutot que de
      // presenter un classement vectoriel qui n'a aucun sens.
      const meilleur = Math.max(...resultats.map((r) => r.score));
      const classement =
        vecteur && meilleur >= config.seuilSimilarite ? 'vectoriel' : 'lexicographique';

      const ordonnes =
        classement === 'vectoriel'
          ? resultats
          : [...resultats].sort(
              (a, b) =>
                (a.prix_ttc ?? Number.POSITIVE_INFINITY) -
                  (b.prix_ttc ?? Number.POSITIVE_INFINITY) || a.id.localeCompare(b.id),
            );

      return {
        ...base,
        statut: 'ok',
        filtresAppliques: courants as Filtres,
        relachements,
        classement,
        resultats: ordonnes,
      };
    }

    const cran = relacherUnCran(courants, origine);
    if (!cran) break;
    courants = cran.filtres;
    relachements.push(cran.relachement);
  }

  return { ...base, statut: 'vide', filtresAppliques: courants as Filtres, relachements };
}

/**
 * Relache exactement UNE contrainte d'un cran, en suivant l'ordre declare dans
 * la config. Retourne null quand plus rien n'est relachable: le systeme repond
 * alors "je n'ai rien", il n'elargit jamais en silence.
 */
function relacherUnCran(
  courants: Record<string, any>,
  origine: Record<string, any>,
): { filtres: Record<string, any>; relachement: Relachement } | null {
  for (const cle of config.ordreElargissement) {
    const valeur = courants[cle];
    if (valeur === null || valeur === undefined) continue;

    const champ = champParCle.get(cle);
    if (!champ?.relacher) continue;

    const suivant = champ.relacher(valeur, origine[cle]);
    if (!suivant) continue;

    return {
      filtres: { ...courants, [cle]: suivant.valeur },
      relachement: { champ: cle, libelle: champ.libelle, annonce: suivant.annonce },
    };
  }
  return null;
}
