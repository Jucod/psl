import { describe, expect, it } from 'vitest';
import { verifierSortie } from '../src/llm/controle-sortie.js';
import type { Resultat } from '../src/moteur/types.js';

function cuvee(p: Partial<Resultat>): Resultat {
  return {
    id: 'x', nom_cuvee: 'X', domaine: 'Domaine X', domaine_id: 'x', commune: null,
    appellation_id: 'aoc-pic-saint-loup', couleur: 'rouge', millesime: 2022,
    degre: null, elevage: null, prix_ttc: null, prix_date_releve: null, bio: null,
    certification: null, assemblage: [], fiche_url: null,
    note_degustation: null, note_source: null, accords_producteur: [],
    niveau: 'cuvee', profil_appellation: null, score: 0, fixture: false,
    extrait_pertinent: null,
    ...p,
  };
}

const ARBOUSE = cuvee({
  id: 'arbouse', nom_cuvee: "L'Arbouse", domaine: 'Mas Bruguiere',
  elevage: '12 mois en foudre',
  note_degustation:
    'La bouche est souple et coulante, les tanins sont fondus, la finale reste fraiche.',
});
const VIGNES = cuvee({
  id: 'vignes', nom_cuvee: 'Vieilles Vignes', domaine: 'Chateau de Lancyre',
  note_degustation: 'Bouche dense et charpentee, tanins presents et serres.',
});

/**
 * Le projet applique la meme regle aux deux bouts: a l'ingestion, une note
 * extraite doit figurer litteralement dans le PDF; en sortie, une citation doit
 * figurer litteralement dans le passage fourni.
 */
describe('controle de sortie', () => {
  it('accepte une citation litterale', () => {
    const texte =
      "Mas Bruguiere, L'Arbouse 2022. « La bouche est souple et coulante, les tanins sont fondus »";
    expect(verifierSortie(texte, [ARBOUSE])).toHaveLength(0);
  });

  it('rejette une citation reformulee, meme fidele au sens', () => {
    // Le piege: c'est vrai, c'est proche, et ce n'est pas ce que le producteur
    // a ecrit. La regle ne juge pas le sens, elle verifie la lettre.
    const texte = "Mas Bruguiere, L'Arbouse. « La bouche se montre souple, aux tanins fondus »";
    const a = verifierSortie(texte, [ARBOUSE]);
    expect(a.map((x) => x.type)).toContain('citation_non_litterale');
  });

  it('rejette une citation purement inventee', () => {
    const texte = "L'Arbouse : « Des notes de truffe blanche et de cuir patine. »";
    expect(verifierSortie(texte, [ARBOUSE]).length).toBeGreaterThan(0);
  });

  it('ATTRIBUTION CROISEE: rejette une note attribuee a la mauvaise cuvee', () => {
    // Le controle global par familles laissait passer ce cas: "tannique" etait
    // autorise parce qu'une AUTRE note le contenait. Le scope par reference
    // est ce qui l'attrape.
    const texte =
      "Mas Bruguiere, L'Arbouse 2022 presente des tanins fermes et une bouche dense et charpentee.";
    const a = verifierSortie(texte, [ARBOUSE, VIGNES]);
    expect(a.map((x) => x.type)).toContain('descripteur_absent');
    expect(a.some((x) => x.detail.includes('arbouse'))).toBe(true);
  });

  it('ne rejette pas un fait technique venu des donnees de la reference', () => {
    // Faux positif corrige en cours de route: "foudre" appartient a la famille
    // boise, absente de la note mais presente dans le champ elevage fourni.
    const texte = "Mas Bruguiere, L'Arbouse 2022, elevage 12 mois en foudre.";
    expect(verifierSortie(texte, [ARBOUSE])).toHaveLength(0);
  });

  it('ne sature pas quand plusieurs notes couvrent le lexique', () => {
    // C'est la panne du controle precedent: avec assez de notes, l'ensemble
    // autorise couvrait tout le lexique et plus rien ne pouvait etre rejete.
    const texte =
      "Mas Bruguiere, L'Arbouse 2022 : une bouche dense, charpentee, aux tanins serres.";
    expect(verifierSortie(texte, [ARBOUSE, VIGNES]).length).toBeGreaterThan(0);
  });

  it("le registre evocateur n'est PAS couvert, et c'est a dire explicitement", () => {
    // Ce controle sert le contrat "aucune invention", pas la loi Evin. Le
    // lexique ne contient aucun mot d'ambiance, donc rien ne sera rejete ici.
    // Cette limite est enoncee dans le README plutot que masquee par un test
    // qui donnerait l'illusion d'une couverture.
    const texte = "Mas Bruguiere, L'Arbouse 2022. Une soiree d ete entre amis, a partager.";
    expect(verifierSortie(texte, [ARBOUSE]).filter((a) => a.type === 'descripteur_absent'))
      .toHaveLength(0);
  });
});
