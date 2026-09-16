import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { fermer } from '../src/db/client.js';
import { rechercher } from '../src/moteur/recherche.js';
import { EmbeddingLocal } from '../src/embeddings/local.js';
import { texteVectoriel } from '../src/llm/parseur.js';
import { combiner } from '../src/pipeline.js';
import { config } from '../src/config/domaine.js';
import { FILTRES_VIDES, type Filtres } from '../src/schema/filtres.js';

const PSL = 'aoc-pic-saint-loup';
const emb = new EmbeddingLocal(config.dimensionEmbedding);

function filtres(partiel: Partial<Filtres>): Filtres {
  return { ...FILTRES_VIDES, appellation: PSL, ...partiel };
}

/** Construit le vecteur de requete exactement comme le pipeline. */
async function vecteur(f: Filtres): Promise<number[] | null> {
  const t = texteVectoriel(f);
  if (!t) return null;
  const [vIn, vEx] = await emb.embed([t.inclus || ' ', ...(t.exclus ? [t.exclus] : [])]);
  return vEx ? combiner(vIn!, vEx, config.poidsRejet) : vIn!;
}

const options = { autoriserFixtures: true };

const DOSSIER_CALQUE = new URL('../db/seed/cuvees.fixtures/', import.meta.url);

/** Contenu du calque de developpement, lu a la source. */
const CALQUE: { id: string; cles: string[] }[] = (() => {
  try {
    return readdirSync(DOSSIER_CALQUE)
      .filter((x) => x.endsWith('.json'))
      .map((x) => JSON.parse(readFileSync(new URL(x, DOSSIER_CALQUE), 'utf8')))
      .map((o: Record<string, unknown>) => ({
        id: String(o.id),
        cles: Object.keys(o).filter((k) => !k.startsWith('_') && k !== 'id'),
      }));
  } catch {
    return [];
  }
})();
const IDS_CALQUE = new Set(CALQUE.map((c) => c.id));

/**
 * Le calque est temporaire: l'objectif du projet est de le supprimer. Le jour
 * ou il disparait, ces cas n'ont plus de sujet. On les SAUTE visiblement
 * plutot que de les laisser passer sur un ensemble vide, ce qui les
 * transformerait en faux temoins silencieux.
 */
const siCalque = IDS_CALQUE.size > 0 ? it : it.skip;

/**
 * Construit un etat de catalogue dans une transaction annulee.
 *
 * Un pool a connexion UNIQUE est indispensable: avec un pool ordinaire le
 * moteur prendrait une autre connexion et ne verrait pas la transaction.
 */
async function dansUneTransaction<T>(
  preparation: string, corps: (pool: pg.Pool) => Promise<T>,
): Promise<T> {
  const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await p.query('BEGIN');
    await p.query(preparation);
    return await corps(p);
  } finally {
    await p.query('ROLLBACK').catch(() => {});
    await p.end();
  }
}

// Partition etablie en LISANT les notes, pas en triant les scores: choisir les
// membres d'apres le classement qu'on teste serait circulaire. Chaque id porte
// le segment de sa note qui le range.
const SOUPLES = [
  'morties-que-sera-sera-2024',      // "les tanins fins et delicats"
  'mas-bruguiere-l-arbouse-2024',    // "la rondeur s'associe a une belle fraicheur"
  'mas-foulaquier-l-orphee-2023',    // "alliant gourmandise, souplesse et puissance"
  'mas-foulaquier-les-calades-2024', // "alliant gourmandise, souplesse et epice"
];
const CHARPENTES = [
  'lancyre-vieilles-vignes-2022',    // "Bouche dense et charpentee, tanins presents et serres"
  'lancyre-grande-cuvee-2021',       // "Bouche puissante et structuree, tanins fermes"
  'morties-pic-saint-loup-2024',     // "des tanins presents qui s'affineront"
];

describe('jalon 2 - recherche hybride', () => {
  afterAll(async () => { await fermer(); });

  it('CAS REFUS: un blanc en Pic Saint-Loup est refuse, pas approxime', async () => {
    const r = await rechercher(filtres({ couleur: 'blanc' }), options);

    expect(r.statut).toBe('refus_hors_catalogue');
    expect(r.resultats).toHaveLength(0);
    expect(r.refus?.message).toMatch(/ne couvre pas les blancs/i);
    // Le refus dit ce qui existe...
    expect(r.refus?.message).toMatch(/rouge/);
    expect(r.refus?.message).toMatch(/rose/);
    // ...et cite sa source.
    expect(r.refus?.source?.url).toMatch(/^https?:\/\//);
  });

  it('CAS VIDE: un critere couvert par l AOC mais absent du catalogue', async () => {
    // Ce cas portait sur le rose, qui n'etait alors represente par aucune
    // cuvee. Le corpus reel en contient un (Dame Jeanne 2025): la premisse
    // est morte, et c'est une bonne nouvelle. On la reconstruit sur l'axe
    // cepage, ou elle est plus discriminante: le cinsaut est autorise par
    // l'encepagement de l'AOC, donc AUCUN refus de couverture n'est du,
    // mais aucune cuvee du catalogue n'en contient.
    //
    // Les trois etats du meme axe sont ainsi tenus par trois tests:
    //   chardonnay -> refus (hors encepagement AOC)
    //   cinsaut    -> vide  (dans l'AOC, absent du catalogue)
    //   syrah      -> ok
    const r = await rechercher(filtres({ couleur: 'rouge', cepages_inclus: ['cinsaut'] }), options);

    expect(r.statut).toBe('vide');
    expect(r.resultats).toHaveLength(0);
    expect(r.refus).toBeNull();
    // Le catalogue n'est pas vide: c'est bien ce cepage-la qui est absent.
    expect(r.tailleCatalogue).toBeGreaterThan(0);
    // Et on ne pretexte pas une donnee manquante: les assemblages sont connus.
    expect(r.filtresIndecidables).toHaveLength(0);
  });

  it('CAS ROSE: une couleur de l AOC desormais representee repond normalement', async () => {
    // Temoin de la bascule fixtures -> donnees reelles: le rose etait le trou
    // du catalogue, il ne l'est plus. Si ce test redevient vide, le corpus a
    // regresse.
    const r = await rechercher(filtres({ couleur: 'rose' }), options);

    expect(r.statut).toBe('ok');
    expect(r.resultats.length).toBeGreaterThan(0);
    expect(r.refus).toBeNull();
    for (const c of r.resultats) expect(c.couleur).toBe('rose');
  });

  it('CAS ELARGISSEMENT: le budget est relache par paliers, et annonce', async () => {
    // Rien sous 12 euros: le rouge le moins cher du catalogue est a 16.
    const r = await rechercher(filtres({ couleur: 'rouge', prix_max: 12 }), options);

    expect(r.statut).toBe('ok');
    expect(r.relachements.length).toBeGreaterThan(0);
    expect(r.relachements[0]!.champ).toBe('prix_max');
    expect(r.relachements[0]!.annonce).toMatch(/budget porte de/);
    // Le budget applique a bouge, celui demande non.
    expect(r.filtresAppliques.prix_max).toBeGreaterThan(12);
    expect(r.filtresDemandes.prix_max).toBe(12);
    // Plafond a +50%: on ne derive pas indefiniment.
    expect(r.filtresAppliques.prix_max).toBeLessThanOrEqual(12 * 1.5 + 0.01);
  });

  it("CAS ELARGISSEMENT: le plafond annonce est ATTEIGNABLE, pas decoratif", async () => {
    // Regression. L'echelle montait par paliers de 25 % et abandonnait des
    // que le palier SUIVANT depassait le plafond, au lieu de s'y caler:
    // 12 € -> 15 €, puis 18,75 € > 18 € donc arret. On repondait "rien
    // trouve" en gardant 3 € de marge annoncee sous le coude, alors que deux
    // cuvees etaient a 16 €. Un plafond qu'on ne peut pas atteindre ment sur
    // ce que le systeme a reellement essaye.
    //
    // Invisible sur le corpus de fixtures: la moins chere y etait a 14 €,
    // donc le premier palier suffisait toujours.
    const r = await rechercher(filtres({ couleur: 'rouge', prix_max: 12 }), options);

    expect(r.statut).toBe('ok');
    expect(r.filtresAppliques.prix_max).toBeCloseTo(18, 2);
    // Chaque cran est annonce, et chacun avance.
    const annonces = r.relachements.map((x) => x.annonce);
    expect(annonces.length).toBeGreaterThanOrEqual(2);
    expect(new Set(annonces).size).toBe(annonces.length);
    // Et le resultat tient dans le plafond annonce.
    for (const c of r.resultats) expect(c.prix_ttc).toBeLessThanOrEqual(18);
  });

  it('CAS SANS ELARGISSEMENT POSSIBLE: rien, et on le dit', async () => {
    const r = await rechercher(filtres({ couleur: 'rouge', prix_max: 3 }), options);

    expect(r.statut).toBe('vide');
    expect(r.resultats).toHaveLength(0);
    // Des relachements ont bien ete tentes avant d'abandonner.
    expect(r.relachements.length).toBeGreaterThan(0);
  });

  it("L'APPELLATION N'EST JAMAIS RELACHEE en silence", async () => {
    const r = await rechercher(filtres({ couleur: 'rouge', prix_max: 3 }), options);
    expect(r.relachements.some((x) => x.champ === 'appellation')).toBe(false);
    expect(r.filtresAppliques.appellation).toBe(PSL);
  });

  it('CAS CLASSEMENT: "pas trop tannique" separe les souples des charpentes', async () => {
    // Asserter un RANG EXACT serait un faux temoin: entre deux notes aussi
    // souples l'une que l'autre, l'ecart vaut le bruit de collision du
    // hachage. Ce qui est reellement discrimine, c'est la PARTITION.
    //
    // maxResultats couvre tout le catalogue rouge: sur un top-3, les trois
    // premiers sont souvent a egalite et la partition n'est pas observable.
    const f = filtres({
      couleur: 'rouge',
      descripteurs: ['souple'], descripteurs_exclus: ['tannique'],
    });
    const r = await rechercher(f, {
      ...options, vecteurRequete: await vecteur(f), maxResultats: 50,
    });

    expect(r.statut).toBe('ok');
    expect(r.classement).toBe('vectoriel');

    const score = (id: string) => r.resultats.find((x) => x.id === id)?.score;
    const scoresSouples = SOUPLES.map(score).filter((s): s is number => s !== undefined);
    const scoresCharpentes = CHARPENTES.map(score).filter((s): s is number => s !== undefined);

    // Sans ces deux egalites, un id renomme sortirait du jeu en silence et le
    // test passerait sur un ensemble vide.
    expect(scoresSouples.length).toBe(SOUPLES.length);
    expect(scoresCharpentes.length).toBe(CHARPENTES.length);

    const pireSouple = Math.min(...scoresSouples);
    const meilleurCharpente = Math.max(...scoresCharpentes);
    expect(pireSouple).toBeGreaterThan(meilleurCharpente);
    // Marge exigee, pour que le test tombe si le signal se DEGRADE et pas
    // seulement s'il s'inverse. Valeur observee sur le corpus reel: 0,27,
    // bornee par Morties Pic Saint-Loup, la note la plus ambigue des sept
    // ("bouche equilibree" ET "tanins presents"). 0,20 garde ~25 % de jeu.
    expect(pireSouple - meilleurCharpente).toBeGreaterThan(0.20);
  });

  it('CAS INVERSE: la partition s inverse quand la demande s inverse', async () => {
    // Une assertion negative sur un seul id passerait sur un tri par prix, par
    // id, ou au hasard. On reteste donc la partition entiere, dans l'autre
    // sens: les memes deux groupes doivent echanger leurs places.
    //
    // La version precedente lisait le score avec "?? -Infinity". Apres le
    // renommage des cuvees, les ids compares n'existaient plus et elle
    // comparait -Infinity a -Infinity: verte, et ne temoignant de rien.
    const f = filtres({
      couleur: 'rouge',
      descripteurs: ['tannique', 'concentre'], descripteurs_exclus: ['souple'],
    });
    const r = await rechercher(f, {
      ...options, vecteurRequete: await vecteur(f), maxResultats: 50,
    });

    expect(r.statut).toBe('ok');
    expect(r.classement).toBe('vectoriel');

    const score = (id: string) => {
      const c = r.resultats.find((x) => x.id === id);
      // Echouer sur l'absence, ne jamais la remplacer par une valeur qui
      // rendrait la comparaison vraie.
      expect(c, `${id} absent du classement`).toBeDefined();
      return c!.score;
    };
    const pireCharpente = Math.min(...CHARPENTES.map(score));
    const meilleurSouple = Math.max(...SOUPLES.map(score));
    expect(pireCharpente).toBeGreaterThan(meilleurSouple);
  });

  it('respecte le plafond de resultats sans rendre une liste vide', async () => {
    const r = await rechercher(filtres({ couleur: 'rouge' }), options);
    expect(r.resultats.length).toBeGreaterThan(0);
    expect(r.resultats.length).toBeLessThanOrEqual(config.maxResultats);
  });

  it('chaque resultat porte une source exploitable', async () => {
    const r = await rechercher(filtres({ couleur: 'rouge' }), options);
    for (const c of r.resultats) {
      if (c.niveau === 'cuvee') {
        expect(c.note_source).not.toBeNull();
        expect(c.note_source!.url).toMatch(/^https?:\/\//);
      } else {
        // Repli sur le profil d'appellation: annonce et source obligatoires.
        expect(c.note_degustation).toBeNull();
        expect(c.profil_appellation).not.toBeNull();
      }
    }
  });

  siCalque('SEPARATION DES NIVEAUX: le calque est masque, la cuvee reste visible', async () => {
    // Ce cas verifiait la propriete sur TOUT le catalogue, du temps ou toutes
    // les cuvees venaient du calque. Le corpus reel l'a rendue fausse dans ce
    // sens-la, et c'est le progres attendu. Le test verifie donc maintenant
    // les DEUX cotes: la ligne de calque est masquee, la ligne reelle est
    // intacte. C'est un temoin plus fort que l'ancien, qui passait aussi si
    // le moteur masquait tout indistinctement.
    const r = await rechercher(
      filtres({ couleur: 'rouge' }), { autoriserFixtures: false, maxResultats: 50 },
    );

    expect(r.statut).toBe('ok');
    const calque = r.resultats.filter((c) => IDS_CALQUE.has(c.id));
    const reelles = r.resultats.filter((c) => !IDS_CALQUE.has(c.id));

    // Sans ces deux bornes, tout ce qui suit passerait sur un ensemble vide.
    expect(calque.length).toBeGreaterThan(0);
    expect(reelles.length).toBeGreaterThan(0);

    for (const c of calque) {
      // On masque les CHAMPS, on n'exclut pas la ligne. Exclure faisait
      // repondre "catalogue vide" sur un catalogue de cinq cuvees.
      expect(c.note_degustation, c.id).toBeNull();
      expect(c.note_source, c.id).toBeNull();
      expect(c.niveau, c.id).toBe('appellation');
      expect(c.profil_appellation, c.id).not.toBeNull();
      // Le calque ne pose pas que la note: prix et assemblage aussi.
      expect(c.prix_ttc, c.id).toBeNull();
      expect(c.assemblage, c.id).toHaveLength(0);
      expect(c.fixture, c.id).toBe(true);
    }
    for (const c of reelles) {
      // Et une cuvee relevee chez le producteur ne subit rien de tout ca.
      expect(c.note_degustation, c.id).not.toBeNull();
      expect(c.note_source!.url, c.id).toMatch(/^https?:\/\//);
      expect(c.niveau, c.id).toBe('cuvee');
      expect(c.fixture, c.id).toBe(false);
    }
  });

  siCalque('un filtre de prix ne retient pas une cuvee dont le prix est masque', async () => {
    // Filtrer sur une valeur qu'on refuse d'afficher serait pire que de
    // l'exclure. Le prix des lignes de calque n'existe pas ici, donc aucune
    // d'elles ne peut satisfaire un budget, si large soit-il.
    const r = await rechercher(
      filtres({ couleur: 'rouge', prix_max: 1000 }), { autoriserFixtures: false, maxResultats: 50 },
    );
    // Le filtre retient bien quelque chose: les cuvees reelles ont un prix.
    expect(r.resultats.length).toBeGreaterThan(0);
    for (const c of r.resultats) expect(IDS_CALQUE.has(c.id), `${c.id} masque mais retenu`).toBe(false);
  });

  siCalque('un filtre de cepage ne retient pas une cuvee dont l assemblage est masque', async () => {
    const r = await rechercher(
      filtres({ couleur: 'rouge', cepages_inclus: ['syrah'] }),
      { autoriserFixtures: false, maxResultats: 50 },
    );
    expect(r.resultats.length).toBeGreaterThan(0);
    for (const c of r.resultats) expect(IDS_CALQUE.has(c.id), `${c.id} masque mais retenu`).toBe(false);
  });

  it('les filtres de cepage passent par la jointure', async () => {
    const avec = await rechercher(filtres({ couleur: 'rouge', cepages_inclus: ['mourvedre'] }), options);
    const sans = await rechercher(filtres({ couleur: 'rouge', cepages_exclus: ['mourvedre'] }), options);

    const idsAvec = new Set(avec.resultats.map((c) => c.id));
    for (const c of sans.resultats) expect(idsAvec.has(c.id)).toBe(false);
    for (const c of avec.resultats) {
      expect(c.assemblage.some((a) => a.cepage === 'mourvedre')).toBe(true);
    }
  });

  it("un accord d'appellation ne fuit jamais dans un champ de niveau cuvee", async () => {
    // Que statut vaille 'derive' est garanti par un CHECK Postgres et deja
    // teste en base: le reverifier ici est une tautologie. Ce qui peut
    // reellement mal tourner, c'est qu'un accord deduit du profil se retrouve
    // presente comme une caracteristique de la cuvee.
    const r = await rechercher(filtres({ couleur: 'rouge', plat: 'agneau' }), options);
    expect(r.accordsPourLePlat.length).toBeGreaterThan(0);

    const libelles = r.accordsPourLePlat.map((a) => a.libelle.toLowerCase());
    for (const c of r.resultats) {
      for (const accord of c.accords_producteur) {
        // Un accord du producteur peut coincider, mais il doit venir de SA
        // fiche: il ne doit pas etre recopie depuis le profil d'appellation.
        if (libelles.includes(accord.toLowerCase())) {
          expect(c.note_source, `${c.id}: accord sans source producteur`).not.toBeNull();
        }
      }
      expect(c.note_degustation ?? '').not.toContain('DERIVE');
    }
  });
});

describe('restitution', () => {
  it('le refus nomme l appellation, il n affiche pas son identifiant', async () => {
    const r = await rechercher(filtres({ couleur: 'blanc' }), options);
    expect(r.refus?.message).toContain('Pic Saint-Loup');
    expect(r.refus?.message).not.toContain('aoc-pic-saint-loup');
  });
});

describe('regressions issues de la revue', () => {
  it('REFUS CEPAGE: un cepage hors encepagement est refuse, pas ignore', async () => {
    // Avant: normaliserFiltres supprimait le cepage non resolu, la contrainte
    // s'evaporait, et "avez-vous du chardonnay ?" rendait trois rouges.
    const { executerPipeline } = await import('../src/pipeline.js');
    const sortie = await executerPipeline({ message: 'avez-vous du chardonnay ?' });

    expect(sortie.statut).toBe('refus_hors_catalogue');
    expect(sortie.recherche?.resultats).toHaveLength(0);
    expect(sortie.recherche?.refus?.message).toMatch(/chardonnay/i);
    expect(sortie.recherche?.refus?.message).toMatch(/encepagement/i);
    // Un refus cite sa source, comme celui de la couleur.
    expect(sortie.recherche?.refus?.source?.url).toMatch(/^https?:\/\//);
  });

  it('un cepage de l appellation passe normalement', async () => {
    const { executerPipeline } = await import('../src/pipeline.js');
    const sortie = await executerPipeline({ message: 'un rouge a base de syrah' });
    expect(sortie.statut).toBe('ok');
    expect(sortie.recherche!.resultats.length).toBeGreaterThan(0);
  });

  it('ELARGISSEMENT: la boucle progresse ou s arrete, elle ne pietine pas', async () => {
    // Avant: un budget arrondi a lui-meme monopolisait l'echelle, annonçant
    // treize fois "budget porte de 0.01 € a 0.01 €" sans jamais atteindre le
    // barreau millesime.
    const r = await rechercher(
      filtres({ couleur: 'rouge', prix_max: 0.01, millesime_min: 2022 }), options,
    );

    const annonces = r.relachements.map((x) => x.annonce);
    expect(new Set(annonces).size).toBe(annonces.length);
    // La borne de depart et celle d'arrivee doivent differer. L'ancienne
    // version utilisait \S+, qui ne franchit pas l'espace de "0.01 €" et ne
    // pouvait donc jamais matcher: un faux verrou.
    for (const x of r.relachements) {
      const m = /de (.+?) a (.+?)$/.exec(x.annonce);
      if (m) expect(m[1]).not.toBe(m[2]);
    }
  });

  it('CLASSEMENT LEXICOGRAPHIQUE: l ensemble retourne est bien le moins cher', async () => {
    // Avant: le seuil de pertinence s'appliquait APRES le LIMIT. Le moteur
    // annonçait "classement par prix" en rendant des bouteilles selectionnees
    // par un vecteur qu'il venait de juger non pertinent, en ecartant des
    // moins cheres qui satisfaisaient tous les filtres durs.
    const f = filtres({ couleur: 'rouge', descripteurs_exclus: ['fruits_rouges'] });
    const r = await rechercher(f, { ...options, vecteurRequete: await vecteur(f) });

    expect(r.classement).toBe('lexicographique');
    {
      const prix = r.resultats.map((c) => c.prix_ttc ?? Infinity);
      const tous = await rechercher(filtres({ couleur: 'rouge' }), { ...options, maxResultats: 99 });
      const attendus = tous.resultats
        .map((c) => c.prix_ttc ?? Infinity)
        .sort((a, b) => a - b)
        .slice(0, prix.length);
      expect(prix.slice().sort((a, b) => a - b)).toEqual(attendus);
    }
  });
});

describe('regressions de la seconde revue', () => {
  siCalque("N2: une absence ne se conclut pas d'une ignorance", async () => {
    // "sans mourvedre" sur une cuvee dont l'assemblage est masque: le moteur
    // l'affirmait sur un vin qui en contient 25 %. C'est la seule affirmation
    // factuellement fausse sur un produit qu'un tel moteur puisse produire.
    const f = filtres({ couleur: 'rouge', cepages_exclus: ['mourvedre'] });
    const avecCalque = await rechercher(f, { autoriserFixtures: true, maxResultats: 50 });
    const sansCalque = await rechercher(f, { autoriserFixtures: false, maxResultats: 50 });

    // Assemblage connu: le filtre discrimine reellement.
    expect(avecCalque.resultats.length).toBeGreaterThan(0);
    for (const c of avecCalque.resultats) {
      expect(c.assemblage.some((a) => a.cepage === 'mourvedre'), c.id).toBe(false);
    }
    // Au moins une ligne de calque passe le filtre quand son assemblage est
    // lisible: sans ca, l'assertion suivante ne prouverait rien.
    expect(avecCalque.resultats.some((c) => IDS_CALQUE.has(c.id))).toBe(true);

    // Assemblage inconnu: on ne conclut rien. Aucune ligne de calque ne doit
    // etre presentee comme "sans mourvedre" alors qu'on ignore ce qu'elle
    // contient.
    for (const c of sansCalque.resultats) {
      expect(IDS_CALQUE.has(c.id), `${c.id}: absence affirmee sur un assemblage inconnu`).toBe(false);
    }
  });

  it('N6: une donnee manquante n est pas une absence de correspondance', async () => {
    // "Aucun vin sous 20 €" et "je n'ai le prix d'aucun vin" sont deux
    // reponses differentes, et donner la premiere pour la seconde est une
    // affirmation sans fondement.
    //
    // Ce cas reposait sur un accident du corpus: aucun prix n'etait relevable
    // sans le calque. Les 15 cuvees reelles en portent un, donc la situation
    // ne se produit plus d'elle-meme. On la CONSTRUIT, dans une transaction
    // annulee, plutot que d'attendre du catalogue qu'il reste pauvre: le test
    // survivra a la croissance du corpus, ce que l'ancien ne faisait pas.
    const r = await dansUneTransaction(
      'UPDATE cuvees SET prix_ttc = NULL',
      (pool) => rechercher(
        filtres({ couleur: 'rouge', prix_max: 20 }),
        { pool, autoriserFixtures: true },
      ),
    );

    expect(r.statut).toBe('vide');
    expect(r.filtresIndecidables.map((f) => f.champ)).toContain('prix_max');
    // Et le catalogue n'est pas vide pour autant: c'est bien la donnee qui
    // manque, pas les cuvees.
    expect(r.tailleCatalogue).toBeGreaterThan(0);
  });

  it('N6 ter: le prix connu de la majorite ne masque pas le prix inconnu du reste', async () => {
    // Le pendant du cas precedent sur le corpus tel qu'il est: les prix sont
    // connus, donc aucun critere n'est indecidable et le moteur repond.
    const r = await rechercher(
      filtres({ couleur: 'rouge', prix_max: 20 }), { autoriserFixtures: true },
    );
    expect(r.statut).toBe('ok');
    expect(r.filtresIndecidables).toHaveLength(0);
    for (const c of r.resultats) expect(c.prix_ttc).toBeLessThanOrEqual(20);
  });

  it('N6 bis: un critere decidable n est pas signale comme indecidable', async () => {
    const r = await rechercher(
      filtres({ couleur: 'rouge', prix_max: 1 }), { autoriserFixtures: true },
    );
    expect(r.statut).toBe('vide');
    expect(r.filtresIndecidables).toHaveLength(0);
  });

  it('N7: un signal de niveau appellation ne fait pas un classement de cuvees', async () => {
    // Quand toutes les lignes retombent sur le MEME profil AOC, leurs vecteurs
    // sont identiques: l'ordre n'est qu'un departage, et annoncer "classement
    // par pertinence" presenterait une caracteristique d'appellation comme une
    // caracteristique de cuvee.
    //
    // Meme remarque qu'en N6: cet etat etait celui du catalogue de fixtures,
    // il ne l'est plus. On le construit.
    const f = filtres({ couleur: 'rouge', descripteurs: ['souple'] });
    const v = await vecteur(f);
    const r = await dansUneTransaction(
      `UPDATE cuvees SET note_degustation = NULL, note_degustation_source_id = NULL,
                        embedding_niveau = 'appellation', embedding = NULL`,
      (pool) => rechercher(f, { pool, autoriserFixtures: true, vecteurRequete: v }),
    );

    expect(r.resultats.length).toBeGreaterThan(0);
    expect(r.resultats.every((c) => c.niveau === 'appellation')).toBe(true);
    expect(r.classement).toBe('lexicographique');
  });

  it('N7 bis: des notes de cuvee, elles, autorisent le classement vectoriel', async () => {
    // Le pendant: le garde-fou de N7 ne doit pas etre si large qu'il
    // interdise tout classement. Sur le corpus reel, il y a de quoi classer.
    const f = filtres({ couleur: 'rouge', descripteurs: ['souple'], descripteurs_exclus: ['tannique'] });
    const r = await rechercher(f, {
      ...options, vecteurRequete: await vecteur(f), maxResultats: 50,
    });
    expect(r.resultats.some((c) => c.niveau === 'cuvee')).toBe(true);
    expect(r.classement).toBe('vectoriel');
  });

  it('le vecteur de rejet participe reellement au classement', async () => {
    // Temoin du mecanisme lui-meme: sur une demande de REJET SEUL, le vecteur
    // de requete n'existe que par le rejet. A poidsRejet = 0 il serait
    // degenere et il n'y aurait aucun classement vectoriel du tout.
    //
    // maxResultats couvre tout le catalogue rouge. Sur un top-5 de 16 cuvees,
    // "le dernier" est le cinquieme, pas le moins bien classe: l'assertion ne
    // porterait plus sur ce qu'elle nomme.
    const f = filtres({ couleur: 'rouge', descripteurs_exclus: ['tannique'] });
    const v = await vecteur(f);
    expect(v).not.toBeNull();

    const r = await rechercher(f, { ...options, vecteurRequete: v, maxResultats: 50 });
    expect(r.classement).toBe('vectoriel');

    // Les cuvees dont la note nomme des tanins fermes ferment la marche.
    const rang = (id: string) => {
      const i = r.resultats.findIndex((x) => x.id === id);
      expect(i, `${id} absent du classement`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const dernier = r.resultats[r.resultats.length - 1]!;
    expect(CHARPENTES).toContain(dernier.id);
    // Et une note muette sur la structure passe devant une note qui la nomme:
    // c'est le rejet, et lui seul, qui produit cet ordre.
    expect(rang('bergerie-du-capucin-dame-jeanne-rouge-2022'))
      .toBeLessThan(rang('lancyre-grande-cuvee-2021'));
  });

  siCalque('toute cle posee par le calque est masquee par le moteur', async () => {
    // La liste de masquage de SQL_RESULTATS est maintenue a la main: une
    // nouvelle cle dans un fichier de calque fuirait en silence. Ce test la
    // verrouille durablement.
    const clesCalque = new Set(CALQUE.flatMap((c) => c.cles));
    expect(clesCalque.size).toBeGreaterThan(0);

    const tous = await rechercher(
      filtres({ couleur: 'rouge' }), { autoriserFixtures: false, maxResultats: 50 },
    );
    // Seules les lignes du calque sont concernees: les cuvees reelles portent
    // legitimement ces memes champs, et les exiger nulles partout ferait
    // passer ce test pour un masquage generalise.
    const r = { resultats: tous.resultats.filter((c) => IDS_CALQUE.has(c.id)) };
    expect(r.resultats.length).toBeGreaterThan(0);

    // Correspondance entre les cles du calque et les champs du resultat.
    const projection: Record<string, (c: (typeof r.resultats)[number]) => unknown> = {
      note_degustation: (c) => c.note_degustation,
      note_degustation_source: (c) => c.note_source,
      accords_producteur: (c) => (c.accords_producteur.length ? c.accords_producteur : null),
      prix_ttc: (c) => c.prix_ttc,
      prix_date_releve: (c) => c.prix_date_releve,
      degre: (c) => c.degre,
      bio: (c) => c.bio,
      certification: (c) => c.certification,
      elevage: (c) => c.elevage,
      assemblage: (c) => (c.assemblage.length ? c.assemblage : null),
    };

    for (const cle of clesCalque) {
      const lecture = projection[cle];
      expect(lecture, `cle de calque "${cle}" non couverte par ce test`).toBeDefined();
      for (const c of r.resultats) {
        expect(lecture!(c), `${c.id}.${cle} devrait etre masque`).toBeNull();
      }
    }
  });
});
