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

  it('CAS CLASSEMENT: "pas trop tannique" remonte la cuvee souple', async () => {
    const f = filtres({
      couleur: 'rouge', prix_max: 20,
      descripteurs: ['souple'], descripteurs_exclus: ['tannique'],
    });
    const r = await rechercher(f, { ...options, vecteurRequete: await vecteur(f) });

    expect(r.statut).toBe('ok');
    expect(r.classement).toBe('vectoriel');
    // L'Arbouse dit litteralement "souple et coulante, les tanins sont fondus".
    expect(r.resultats[0]!.id).toBe('mas-bruguiere-l-arbouse-2022');
    // Les Vieilles Vignes ("dense et charpentee, tanins serres") ne passent pas
    // devant, meme si elles sont dans le budget.
    const rangVignes = r.resultats.findIndex((x) => x.id === 'lancyre-vieilles-vignes-2022');
    expect(rangVignes === -1 || rangVignes > 0).toBe(true);
  });

  it('CAS INVERSE: une demande de vin charpente ne remonte pas la cuvee souple', async () => {
    const f = filtres({ couleur: 'rouge', descripteurs: ['tannique', 'concentre'] });
    const r = await rechercher(f, { ...options, vecteurRequete: await vecteur(f) });

    expect(r.statut).toBe('ok');
    expect(r.resultats[0]!.id).not.toBe('mas-bruguiere-l-arbouse-2022');
  });

  it('respecte le plafond de resultats', async () => {
    const r = await rechercher(filtres({ couleur: 'rouge' }), options);
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

  it('SEPARATION DES NIVEAUX: sans fixture, aucune note n est servie', async () => {
    // Le flag coupe le service, pas seulement l'ingestion: c'est le verrou qui
    // protege une demo publique deployee avec des fixtures encore en base.
    const r = await rechercher(filtres({ couleur: 'rouge' }), { autoriserFixtures: false });

    expect(r.resultats.every((c) => c.note_degustation === null)).toBe(true);
    expect(r.resultats.every((c) => c.fixture === false)).toBe(true);
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

  it('les accords proposes sont toujours marques comme derives', async () => {
    const r = await rechercher(filtres({ couleur: 'rouge', plat: 'agneau' }), options);
    expect(r.accordsPourLePlat.length).toBeGreaterThan(0);
    expect(r.accordsPourLePlat.every((a) => a.statut === 'derive')).toBe(true);
  });
});

describe('restitution', () => {
  it('le refus nomme l appellation, il n affiche pas son identifiant', async () => {
    const r = await rechercher(filtres({ couleur: 'blanc' }), options);
    expect(r.refus?.message).toContain('Pic Saint-Loup');
    expect(r.refus?.message).not.toContain('aoc-pic-saint-loup');
  });
});
