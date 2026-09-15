import { extrait } from '../llm/local.js';
import type { Resultat, ResultatRecherche } from '../moteur/types.js';

/**
 * Projection envoyee au navigateur.
 *
 * "Les fiches techniques sont publiques mais restent la propriete du domaine:
 * on cite, on ne republie pas." La note du producteur part donc tronquee, avec
 * le lien vers la fiche d'origine. C'est une decision editoriale, appliquee ici
 * a la frontiere HTTP: le moteur, lui, travaille sur la note complete.
 */
const LONGUEUR_CITATION = 220;

export interface ResultatPublic extends Omit<Resultat, 'note_degustation'> {
  note_degustation: string | null;
  note_tronquee: boolean;
}

export function publier(r: ResultatRecherche): Omit<ResultatRecherche, 'resultats'> & {
  resultats: ResultatPublic[];
} {
  return {
    ...r,
    resultats: r.resultats.map((c) => ({
      ...c,
      note_degustation: c.note_degustation ? extrait(c.note_degustation, LONGUEUR_CITATION) : null,
      note_tronquee: c.note_degustation !== null && c.note_degustation.length > LONGUEUR_CITATION,
    })),
    // Les avertissements d'exploitation (vecteurs perimes, etc.) ne concernent
    // pas le visiteur: ils restent dans les logs serveur.
    avertissements: [],
  };
}
