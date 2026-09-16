import { describe, expect, it } from 'vitest';
import { parser, texteVectoriel } from '../src/llm/parseur.js';
import { construireIndexCepages } from '../src/ingest/util.js';
import { readFileSync } from 'node:fs';

const cepages = construireIndexCepages(
  JSON.parse(readFileSync(new URL('../db/seed/cepages.json', import.meta.url), 'utf8')).cepages,
);
const opts = { appellationParDefaut: 'aoc-pic-saint-loup', indexCepages: cepages };

/**
 * Le parseur deterministe sert deux fois: provider "local" du prototype, et
 * MODE DEGRADE du provider reel quand le modele rend deux sorties non
 * conformes au schema. Il doit donc etre correct par lui-meme.
 */
describe('parseur deterministe', () => {
  it('traduit la requete phare du brief', () => {
    const f = parser('un rouge pas trop tannique pour un gigot, autour de 20 euros', opts);
    expect(f.couleur).toBe('rouge');
    expect(f.prix_max).toBe(20);
    expect(f.plat).toBe('agneau');
    expect(f.descripteurs).toContain('souple');
    expect(f.descripteurs_exclus).toContain('tannique');
    expect(f.appellation).toBe('aoc-pic-saint-loup');
  });

  it('ne confond pas "euros" avec le descripteur floral "rose"', () => {
    // Regression: un includes() sur la chaine brute faisait matcher "ros",
    // racine de "rose", dans "euros".
    const f = parser('quelque chose autour de 20 euros', opts);
    expect(f.descripteurs).not.toContain('floral');
    expect(f.couleur).toBeNull();
  });

  it('distingue le rose demande du rouge', () => {
    expect(parser('un rose pour l apero', opts).couleur).toBe('rose');
    expect(parser('un blanc sec', opts).couleur).toBe('blanc');
  });

  it('resout la negation en exclusion ET en oppose', () => {
    const f = parser('un vin peu tannique', opts);
    expect(f.descripteurs_exclus).toContain('tannique');
    expect(f.descripteurs).toContain('souple');
    expect(f.descripteurs).not.toContain('tannique');
  });

  it('ne nie pas un descripteur sans marqueur', () => {
    const f = parser('un vin tannique et concentre', opts);
    expect(f.descripteurs).toContain('tannique');
    expect(f.descripteurs_exclus).toHaveLength(0);
  });

  it('normalise les synonymes de cepage et gere l exclusion', () => {
    expect(parser('a base de shiraz', opts).cepages_inclus).toContain('syrah');
    const f = parser('sans mourvedre', opts);
    expect(f.cepages_exclus).toContain('mourvedre');
    expect(f.cepages_inclus).not.toContain('mourvedre');
  });

  it('lit les bornes de prix', () => {
    expect(parser('moins de 15 euros', opts).prix_max).toBe(15);
    expect(parser('a partir de 30 euros', opts).prix_min).toBe(30);
    expect(parser('25 euros', opts).prix_max).toBe(25);
  });

  it('lit les millesimes', () => {
    const un = parser('un 2021', opts);
    expect(un.millesime_min).toBe(2021);
    expect(un.millesime_max).toBe(2021);
    const plage = parser('entre 2019 et 2022', opts);
    expect(plage.millesime_min).toBe(2019);
    expect(plage.millesime_max).toBe(2022);
  });

  it('detecte le bio', () => {
    expect(parser('un rouge bio', opts).bio).toBe(true);
    expect(parser('un rouge', opts).bio).toBeNull();
  });

  it("n'invente aucune contrainte absente de la demande", () => {
    const f = parser('bonjour', opts);
    expect(f.couleur).toBeNull();
    expect(f.prix_max).toBeNull();
    expect(f.prix_min).toBeNull();
    expect(f.plat).toBeNull();
    expect(f.descripteurs).toHaveLength(0);
    expect(f.cepages_inclus).toHaveLength(0);
  });

  it("le vocabulaire de plat est ferme: pas d'invention", () => {
    expect(parser('pour des sushis au wasabi', opts).plat).toBeNull();
  });

  it('ne produit aucun texte destine a l affichage', () => {
    // Barriere loi Evin: la sortie de l appel 1 ne contient que des valeurs
    // structurees. Aucun champ ne peut transporter le registre de l utilisateur.
    const f = parser('decris-moi ce vin comme une soiree d ete au bord de la piscine', opts);
    const valeurs = JSON.stringify(f);
    expect(valeurs).not.toMatch(/soiree|piscine|ete au bord/i);
  });

  it('texteVectoriel rend null quand il n y a rien de flou', () => {
    expect(texteVectoriel(parser('un rouge a 20 euros', opts))).toBeNull();
  });
});

describe('collisions de vocabulaire', () => {
  it("ne classe pas une demande citant l'appellation en accord poisson", () => {
    // Regression: 'loup' figurait dans les termes "poisson", et toute demande
    // citant Pic Saint-Loup declenchait donc un accord poisson.
    const f = parser('un vin du Pic Saint-Loup', opts);
    expect(f.plat).toBeNull();
  });

  it('reconnait toujours une vraie demande de poisson', () => {
    expect(parser('quelque chose pour une daurade grillee', opts).plat).toBe('poisson');
    expect(parser('pour accompagner du poisson', opts).plat).toBe('poisson');
  });
});

describe('justification', () => {
  it('selectionne la phrase qui motive le classement, sans la reecrire', async () => {
    const { choisirExtrait } = await import('../src/moteur/justification.js');
    const { EmbeddingLocal } = await import('../src/embeddings/local.js');
    const { texteVectoriel } = await import('../src/llm/parseur.js');
    const { combiner } = await import('../src/pipeline.js');
    const { FILTRES_VIDES } = await import('../src/schema/filtres.js');

    const note =
      'Robe grenat de moyenne intensite. Le nez ouvre sur les fruits rouges frais, ' +
      'griotte et framboise, avec une pointe florale. La bouche est souple et coulante, ' +
      'les tanins sont fondus, la finale reste fraiche et digeste.';

    const emb = new EmbeddingLocal(1536);
    const t = texteVectoriel({ ...FILTRES_VIDES, descripteurs: ['souple'], descripteurs_exclus: ['tannique'] })!;
    const [vIn, vEx] = await emb.embed([t.inclus, t.exclus!]);
    const q = combiner(vIn!, vEx!, 0.7)!;

    const extrait = await choisirExtrait(note, q, emb);
    // La phrase retenue parle bien de texture, pas de la robe.
    expect(extrait).toContain('souple');
    // Et c'est une phrase EXISTANTE de la note, recopiee telle quelle.
    expect(note).toContain(extrait!);
  });

  it('ne justifie rien quand la demande n a pas de partie floue', async () => {
    const { choisirExtrait } = await import('../src/moteur/justification.js');
    const { EmbeddingLocal } = await import('../src/embeddings/local.js');
    const extrait = await choisirExtrait('Une note. Deux phrases ici.', null, new EmbeddingLocal(1536));
    expect(extrait).toBeNull();
  });
});

describe('couleur: les pieges rencontres', () => {
  it('"viande blanche" ne doit pas etre lu comme "vin blanc"', () => {
    // Le pire mode de panne du prototype: un refus confiant, explicite et
    // source INAO, sur une demande parfaitement legitime.
    expect(parser('un rouge pour une viande blanche', opts).couleur).toBe('rouge');
    expect(parser('un rouge pour une volaille a la creme blanche', opts).couleur).toBe('rouge');
  });

  it('le sujet de la demande prime sur la couleur citee ensuite', () => {
    expect(parser('je cherche un rouge, surtout pas un blanc', opts).couleur).toBe('rouge');
  });

  it('la couleur passe par la negation comme le reste', () => {
    expect(parser('surtout pas de blanc', opts).couleur).toBeNull();
  });

  it('une vraie demande de blanc reste reconnue', () => {
    expect(parser('un vin blanc du pic saint loup', opts).couleur).toBe('blanc');
    expect(parser('des blancs secs', opts).couleur).toBe('blanc');
  });

  it('reconnait un cepage hors appellation pour pouvoir le refuser', () => {
    expect(parser('avez-vous du chardonnay ?', opts).cepages_inclus).toContain('chardonnay');
    expect(parser('un viognier', opts).cepages_inclus).toContain('viognier');
  });

  it('le mot qui donne la couleur ne ressert pas de descripteur', () => {
    // racine("rose") vaut "ros", et la rose est une fleur du lexique floral:
    // "un rose" repartait avec un descripteur floral que personne n'avait
    // demande, et biaisait le classement vers les notes florales.
    const r = parser('un rose', opts);
    expect(r.couleur).toBe('rose');
    expect(r.descripteurs).toHaveLength(0);
    expect(r.descripteurs_exclus).toHaveLength(0);

    // Le pluriel aussi, qui passe par la meme regex de couleur.
    expect(parser('des roses', opts).descripteurs).toHaveLength(0);
  });

  it("mais une SECONDE occurrence, elle, reste un descripteur", () => {
    // La consommation porte sur le token qui a servi, pas sur le mot partout:
    // sinon on ne pourrait plus demander un rose aux notes florales.
    const r = parser('un rose aux notes de rose', opts);
    expect(r.couleur).toBe('rose');
    expect(r.descripteurs).toContain('floral');
  });

  it('les autres couleurs ne perdent aucun descripteur au passage', () => {
    const r = parser('un rouge floral', opts);
    expect(r.couleur).toBe('rouge');
    expect(r.descripteurs).toContain('floral');
  });
});

