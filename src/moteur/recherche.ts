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
  /**
   * Remplace config.maxResultats. Sert aux tests de classement: observer une
   * partition demande de voir plus de lignes que n'en montre l'interface.
   */
  maxResultats?: number;
}

/**
 * Deux CTE realisent le MASQUAGE des champs issus du calque de developpement
 * quand PSL_AUTORISER_FIXTURES=0.
 *
 * On masque les champs, on n'exclut pas la ligne. Exclure faisait repondre
 * "le catalogue ne contient aucune cuvee" sur un catalogue de cinq cuvees,
 * pendant que /api/catalogue annonçait les memes. Masquer produit le
 * comportement que l'ingestion documente deja: la cuvee reste visible, sa
 * description retombe sur le profil d'appellation, et c'est annonce.
 *
 * Le masquage porte sur les COLONNES, pas seulement sur l'affichage: un
 * prix masque vaut NULL, donc un filtre "moins de 20 €" cesse de le retenir.
 * Filtrer sur une valeur qu'on refuse d'afficher serait pire que de l'exclure.
 *
 * `cuvee_cepages` est volontairement redefinie ici: une CTE masque la table de
 * base pour toute la requete, y compris dans les EXISTS construits par la
 * config. Un assemblage masque cesse donc de repondre a un filtre de cepage.
 */
const SQL_RESULTATS = `
  WITH masquees AS (
    SELECT id FROM cuvees WHERE provenance_fixture AND NOT $2::boolean
  ),
  cuvee_cepages AS (
    SELECT * FROM public.cuvee_cepages
     WHERE cuvee_id NOT IN (SELECT id FROM masquees)
  ),
  c AS (
    SELECT
      b.id, b.domaine_id, b.appellation_id, b.couleur, b.nom_cuvee,
      b.millesime, b.fiche_url, b.embedding, b.provenance_fixture,
      (b.id IN (SELECT id FROM masquees)) AS masque,
      CASE WHEN b.id IN (SELECT id FROM masquees) THEN NULL ELSE b.note_degustation END           AS note_degustation,
      CASE WHEN b.id IN (SELECT id FROM masquees) THEN NULL ELSE b.note_degustation_source_id END AS note_degustation_source_id,
      CASE WHEN b.id IN (SELECT id FROM masquees) THEN NULL ELSE b.prix_ttc END                   AS prix_ttc,
      CASE WHEN b.id IN (SELECT id FROM masquees) THEN NULL ELSE b.prix_date_releve END           AS prix_date_releve,
      CASE WHEN b.id IN (SELECT id FROM masquees) THEN NULL ELSE b.degre END                      AS degre,
      CASE WHEN b.id IN (SELECT id FROM masquees) THEN NULL ELSE b.elevage END                    AS elevage,
      CASE WHEN b.id IN (SELECT id FROM masquees) THEN NULL ELSE b.bio END                        AS bio,
      CASE WHEN b.id IN (SELECT id FROM masquees) THEN NULL ELSE b.certification END              AS certification,
      CASE WHEN b.id IN (SELECT id FROM masquees) THEN '{}'::text[] ELSE b.accords_producteur END AS accords_producteur,
      CASE
        WHEN b.id IN (SELECT id FROM masquees) OR b.note_degustation IS NULL THEN 'appellation'
        ELSE b.embedding_niveau
      END AS embedding_niveau,
      CASE WHEN b.id IN (SELECT id FROM masquees) THEN NULL ELSE b.embedding END AS embedding_visible
    FROM cuvees b
    WHERE b.disponible
  )
  SELECT
    c.id, c.nom_cuvee, c.appellation_id, c.couleur, c.millesime, c.degre,
    c.elevage, c.prix_ttc, c.prix_date_releve::text AS prix_date_releve,
    c.bio, c.certification, c.note_degustation, c.accords_producteur,
    c.fiche_url, c.embedding_niveau, c.provenance_fixture, c.masque,
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
      ELSE 1 - (COALESCE(c.embedding_visible, p.embedding) <=> $1::vector)
    END AS score
  FROM c
  JOIN domaines d ON d.id = c.domaine_id
  LEFT JOIN appellation_profils p
         ON p.appellation_id = c.appellation_id AND p.couleur = c.couleur
  LEFT JOIN sources sn ON sn.id = c.note_degustation_source_id
  LEFT JOIN sources sp ON sp.id = p.source_id
  WHERE `;

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
    fixture: r.provenance_fixture === true,
    extrait_pertinent: null,
  };
}

async function executer(
  pool: pg.Pool,
  filtres: Filtres,
  vecteur: number[] | null,
  autoriserFixtures: boolean,
  maxResultats: number = config.maxResultats,
): Promise<Resultat[]> {
  const { texte, params } = construireClauses(filtres, 3);
  const sql =
    SQL_RESULTATS + `(${texte})\n` +
    `  ORDER BY score DESC NULLS LAST, c.prix_ttc ASC NULLS LAST, c.id\n` +
    `  LIMIT ${Number.isInteger(maxResultats) ? maxResultats : config.maxResultats}`;

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
    `SELECT a.nom, s.id, s.type, s.label, s.url, s.autorite, s.date_releve::text
       FROM appellations a JOIN sources s ON s.id = a.source_id
      WHERE a.id = $1`,
    [valeurs[cles[0]!.filtre]],
  );

  // Le message s'adresse a un visiteur: il doit lire "Pic Saint-Loup", pas
  // "aoc-pic-saint-loup".
  const lisibles = { ...valeurs };
  if (src[0]?.nom) lisibles[cles[0]!.filtre] = src[0].nom;

  return {
    message: message(lisibles, disponibles),
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

/**
 * Quels filtres actifs portent sur une colonne inconnue pour toutes les cuvees
 * candidates ? Les cles de couverture (appellation, couleur) sont exclues: ce
 * sont des criteres d'identite, pas des donnees susceptibles de manquer.
 *
 * Le masquage des fixtures est applique, sinon on conclurait sur des valeurs
 * qu'on refuse d'afficher.
 */
async function filtresIndecidables(
  pool: pg.Pool, filtres: Filtres, autoriserFixtures: boolean,
): Promise<{ champ: string; libelle: string }[]> {
  const identite = new Set(config.couverture.cles.map((c) => c.filtre));
  const candidats = config.champs.filter(
    (c) =>
      c.colonne &&
      !identite.has(c.cle) &&
      (filtres as Record<string, unknown>)[c.cle] !== null &&
      (filtres as Record<string, unknown>)[c.cle] !== undefined,
  );
  if (candidats.length === 0) return [];

  const projections = candidats
    .map((c, i) => `count(${c.colonne}) FILTER (WHERE NOT masque)::int AS n${i}`)
    .join(', ');

  const { rows } = await pool.query(
    `SELECT ${projections}
       FROM (
         SELECT *, (provenance_fixture AND NOT $3::boolean) AS masque
           FROM cuvees
          WHERE disponible
            AND ($1::text IS NULL OR appellation_id = $1)
            AND ($2::text IS NULL OR couleur = $2)
       ) t`,
    [filtres.appellation, filtres.couleur, autoriserFixtures],
  );

  return candidats
    .filter((_, i) => rows[0]![`n${i}`] === 0)
    .map((c) => ({ champ: c.cle, libelle: c.libelle }));
}

async function tailleCatalogue(pool: pg.Pool, filtres: Filtres): Promise<number> {
  const { rows } = await pool.query(
    // Les lignes masquees existent toujours dans le catalogue: seuls leurs
    // champs de developpement sont caches. Les decompter serait mentir sur la
    // taille du catalogue, ce que /api/catalogue contredirait aussitot.
    `SELECT count(*)::int AS n FROM cuvees c
      WHERE c.disponible
        AND ($1::text IS NULL OR c.appellation_id = $1)
        AND ($2::text IS NULL OR c.couleur = $2)`,
    [filtres.appellation, filtres.couleur],
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
  const maxResultats = options.maxResultats ?? config.maxResultats;
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
    filtresIndecidables: [],
  };

  // 1. Le catalogue peut-il, par construction, contenir ce qui est demande ?
  const refus = await verifierCouverture(pool, filtres);
  if (refus) return { ...base, statut: 'refus_hors_catalogue', refus };

  base.tailleCatalogue = await tailleCatalogue(pool, filtres);
  base.accordsPourLePlat = await accordsPourLePlat(pool, filtres);

  // 2. Recherche, puis elargissement UNE contrainte a la fois.
  const origine = { ...filtres } as Record<string, any>;
  let courants = { ...filtres } as Record<string, any>;
  const relachements: Relachement[] = [];

  for (let i = 0; i <= maxIterations; i++) {
    const resultats = await executer(pool, courants as Filtres, vecteur, autoriserFixtures, maxResultats);

    if (resultats.length > 0) {
      // Le seuil doit decider AVANT le LIMIT, pas apres.
      //
      // Re-trier en JS les trois lignes que le vecteur avait selectionnees
      // annonçait "classement par prix" en rendant les 2e et 3e bouteilles les
      // plus cheres du catalogue, deux moins cheres satisfaisant pourtant tous
      // les filtres durs. On relance donc la requete sans vecteur.
      const scores = resultats.map((r) => r.score);
      const ecart = Math.max(...scores) - Math.min(...scores);

      // Deux conditions, toutes deux apprises a l'usage.
      //
      // 1. Un signal de niveau APPELLATION n'est pas un classement de cuvees.
      //    Quand toutes les lignes retombent sur le meme profil AOC, leurs
      //    vecteurs sont IDENTIQUES: le cosinus vaut 0,28 partout, l'ordre
      //    reel n'est que le departage par prix puis par id, et le moteur
      //    annonçait quand meme "classement par pertinence". C'est une
      //    caracteristique d'appellation presentee comme une caracteristique
      //    de cuvee, sous sa forme la plus extreme.
      //
      // 2. La discrimination se mesure a l'ECART, pas a un plancher absolu.
      //    Voir le commentaire de config.seuilDiscrimination.
      const pertinent =
        vecteur !== null &&
        resultats.some((r) => r.niveau === 'cuvee') &&
        ecart >= config.seuilDiscrimination;

      const ordonnes = pertinent
        ? resultats
        : await executer(pool, courants as Filtres, null, autoriserFixtures, maxResultats);

      return {
        ...base,
        statut: 'ok',
        filtresAppliques: courants as Filtres,
        relachements,
        classement: pertinent ? 'vectoriel' : 'lexicographique',
        resultats: ordonnes,
      };
    }

    const cran = relacherUnCran(courants, origine);
    if (!cran) break;
    courants = cran.filtres;
    relachements.push(cran.relachement);
  }

  return {
    ...base,
    statut: 'vide',
    filtresAppliques: courants as Filtres,
    relachements,
    filtresIndecidables: await filtresIndecidables(pool, filtres, autoriserFixtures),
  };
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
    // Un relachement qui ne bouge pas n'est pas un relachement: sans cette
    // garde, un budget arrondi a lui-meme monopolisait l'echelle et le
    // millesime n'etait jamais atteint, tout en annonçant treize fois
    // "budget porte de 0.01 € a 0.01 €".
    if (!suivant || Object.is(suivant.valeur, valeur)) continue;

    return {
      filtres: { ...courants, [cle]: suivant.valeur },
      relachement: { champ: cle, libelle: champ.libelle, annonce: suivant.annonce },
    };
  }
  return null;
}
