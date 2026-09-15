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

  it('CAS VIDE: une couleur couverte par l AOC mais absente du catalogue', async () => {
    // Le rose est autorise par le cahier des charges: pas de refus de
    // couverture. Mais aucune cuvee rose n'est indexee: reponse vide assumee.
    const r = await rechercher(filtres({ couleur: 'rose' }), options);

    expect(r.statut).toBe('vide');
    expect(r.resultats).toHaveLength(0);
    expect(r.tailleCatalogue).toBe(0);
    expect(r.refus).toBeNull();
  });

  it('CAS ELARGISSEMENT: le budget est relache par paliers, et annonce', async () => {
    // Rien sous 12 euros. La cuvee la moins chere est a 14.
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
    // Sur cinq cuvees, asserter un RANG EXACT est un faux temoin: l'ecart
    // entre L'Arbouse et Dame Jeanne vaut 0,008 de cosinus, soit le bruit de
    // collision du hachage. Les deux notes sont d'ailleurs aussi souples l'une
    // que l'autre ("tanins fondus" contre "tanins fins et enrobes"): les
    // donnees ne tranchent pas, et un test ne doit pas pretendre le contraire.
    //
    // Ce qui est reellement discrimine, et avec une marge de 0,45, c'est la
    // PARTITION entre les souples et les charpentes. C'est elle qu'on teste.
    const f = filtres({
      couleur: 'rouge',
      descripteurs: ['souple'], descripteurs_exclus: ['tannique'],
    });
    const r = await rechercher(f, {
      ...options, vecteurRequete: await vecteur(f), maxResultats: 5,
    });

    expect(r.statut).toBe('ok');
    expect(r.classement).toBe('vectoriel');

    const SOUPLES = ['mas-bruguiere-l-arbouse-2022', 'bergerie-du-capucin-dame-jeanne-2022'];
    const CHARPENTES = ['lancyre-vieilles-vignes-2022', 'lancyre-grande-cuvee-2021'];

    const score = (id: string) => r.resultats.find((x) => x.id === id)?.score;
    const scoresSouples = SOUPLES.map(score).filter((s): s is number => s !== undefined);
    const scoresCharpentes = CHARPENTES.map(score).filter((s): s is number => s !== undefined);

    expect(scoresSouples.length).toBe(2);
    expect(scoresCharpentes.length).toBe(2);

    const pireSouple = Math.min(...scoresSouples);
    const meilleurCharpente = Math.max(...scoresCharpentes);
    expect(pireSouple).toBeGreaterThan(meilleurCharpente);
    // Marge exigee, pour que le test tombe si le signal se degrade, et pas
    // seulement s'il s'inverse.
    expect(pireSouple - meilleurCharpente).toBeGreaterThan(0.15);
  });

  it('CAS INVERSE: la partition s inverse quand la demande s inverse', async () => {
    // Une assertion negative sur un id parmi cinq passerait sur un tri par
    // prix, par id, ou au hasard quatre fois sur cinq. On reteste donc la
    // partition, dans l'autre sens.
    const f = filtres({
      couleur: 'rouge',
      descripteurs: ['tannique', 'concentre'], descripteurs_exclus: ['souple'],
    });
    const r = await rechercher(f, {
      ...options, vecteurRequete: await vecteur(f), maxResultats: 5,
    });

    expect(r.statut).toBe('ok');
    const score = (id: string) => r.resultats.find((x) => x.id === id)?.score ?? -Infinity;
    expect(score('lancyre-vieilles-vignes-2022'))
      .toBeGreaterThan(score('mas-bruguiere-l-arbouse-2022'));
    expect(score('lancyre-grande-cuvee-2021'))
      .toBeGreaterThan(score('mas-bruguiere-l-arbouse-2022'));
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

  it('SEPARATION DES NIVEAUX: sans fixture, les champs sont masques mais la cuvee reste visible', async () => {
    const r = await rechercher(filtres({ couleur: 'rouge' }), { autoriserFixtures: false });

    // Sans cette premiere assertion, tout ce qui suit passe sur l'ensemble
    // vide: le test survivrait a la suppression du repli sur le profil.
    expect(r.resultats.length).toBeGreaterThan(0);
    expect(r.statut).toBe('ok');

    for (const c of r.resultats) {
      // On masque les CHAMPS, on n'exclut pas la ligne. Exclure faisait
      // repondre "catalogue vide" sur un catalogue de cinq cuvees.
      expect(c.note_degustation).toBeNull();
      expect(c.note_source).toBeNull();
      expect(c.niveau).toBe('appellation');
      expect(c.profil_appellation).not.toBeNull();
      // Le calque ne pose pas que la note: prix et assemblage aussi.
      expect(c.prix_ttc).toBeNull();
      expect(c.assemblage).toHaveLength(0);
      expect(c.fixture).toBe(true);
    }
  });

  it('un filtre de prix ne retient pas une cuvee dont le prix est masque', async () => {
    // Filtrer sur une valeur qu'on refuse d'afficher serait pire que de
    // l'exclure: le budget vient du calque, donc il n'existe pas ici.
    const r = await rechercher(
      filtres({ couleur: 'rouge', prix_max: 100 }), { autoriserFixtures: false },
    );
    expect(r.resultats).toHaveLength(0);
  });

  it('un filtre de cepage ne retient pas une cuvee dont l assemblage est masque', async () => {
    const r = await rechercher(
      filtres({ couleur: 'rouge', cepages_inclus: ['syrah'] }), { autoriserFixtures: false },
    );
    expect(r.resultats).toHaveLength(0);
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
    for (const x of r.relachements) {
      expect(x.annonce).not.toMatch(/de (\S+) a \1$/);
    }
  });

  it('CLASSEMENT LEXICOGRAPHIQUE: l ensemble retourne est bien le moins cher', async () => {
    // Avant: le seuil de pertinence s'appliquait APRES le LIMIT. Le moteur
    // annonçait "classement par prix" en rendant des bouteilles selectionnees
    // par un vecteur qu'il venait de juger non pertinent, en ecartant des
    // moins cheres qui satisfaisaient tous les filtres durs.
    const f = filtres({ couleur: 'rouge', descripteurs_exclus: ['fruits_rouges'] });
    const r = await rechercher(f, { ...options, vecteurRequete: await vecteur(f) });

    if (r.classement === 'lexicographique') {
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
