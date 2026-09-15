import { FAMILLE_PAR_MOT, normaliser, tokeniser } from '../config/lexique.js';
import type { Resultat } from '../moteur/types.js';

/**
 * Controle de la sortie du modele.
 *
 * Le projet applique deja cette regle a l'ingestion (jalon 5): toute note
 * extraite d'un PDF doit se retrouver litteralement dans sa couche texte.
 * L'appliquer aussi en sortie donne au systeme UNE seule regle, tenue aux deux
 * bouts: rien de descriptif n'existe qui ne soit une citation verifiable.
 *
 * C'est aussi ce qui rend la promesse demontrable en direct devant un prospect,
 * la ou un filtre de vocabulaire ne fait qu'esperer.
 *
 * Deux verifications complementaires:
 *  1. citations - tout segment entre guillemets doit etre une sous-chaine
 *     litterale d'un passage fourni. Exact, zero faux positif, et attrape
 *     l'invention comme la reformulation.
 *  2. descripteurs - hors guillemets, le texte ne doit pas introduire de
 *     famille sensorielle absente de ce qu'on a fourni POUR CETTE REFERENCE.
 *     Le controle est scope par reference: globalement, trois notes couvrant
 *     le lexique saturaient l'ensemble autorise et la verification devenait
 *     mathematiquement incapable de rien rejeter.
 */

export interface Anomalie {
  type: 'citation_non_litterale' | 'descripteur_absent';
  detail: string;
}

/** Segments entre guillemets francais ou droits. */
const CITATION = /[«"]\s*([^»"]{12,600}?)\s*[»"]/g;

function aplatir(t: string): string {
  return normaliser(t).replace(/\s+/g, ' ').trim();
}

export function verifierSortie(texte: string, resultats: readonly Resultat[]): Anomalie[] {
  const anomalies: Anomalie[] = [];

  // --- 1. toute citation doit etre litterale --------------------------------
  const passages = resultats.flatMap((c) =>
    [c.note_degustation, c.extrait_pertinent, c.profil_appellation?.texte]
      .filter((x): x is string => Boolean(x))
      .map(aplatir),
  );

  for (const m of texte.matchAll(CITATION)) {
    const citation = aplatir(m[1]!);
    if (!passages.some((p) => p.includes(citation))) {
      anomalies.push({
        type: 'citation_non_litterale',
        detail: m[1]!.slice(0, 80),
      });
    }
  }

  // --- 2. descripteurs, scopes par reference --------------------------------
  for (const { reference, segment } of segmenter(texte, resultats)) {
    const autorise = famillesDe(
      [
        reference?.note_degustation,
        reference?.extrait_pertinent,
        reference?.profil_appellation?.texte,
        reference?.elevage,
        reference?.certification,
        ...(reference?.assemblage ?? []).map((a) => a.cepage),
      ]
        .filter((x): x is string => Boolean(x))
        .join(' '),
    );

    for (const famille of famillesDe(sansCitations(segment))) {
      if (!autorise.has(famille)) {
        anomalies.push({
          type: 'descripteur_absent',
          detail: `${reference?.id ?? 'introduction'} : ${famille}`,
        });
      }
    }
  }

  return anomalies;
}

function famillesDe(texte: string): Set<string> {
  const familles = new Set<string>();
  for (const t of tokeniser(texte)) {
    const f = FAMILLE_PAR_MOT.get(t);
    if (f) familles.add(f);
  }
  return familles;
}

function sansCitations(texte: string): string {
  return texte.replace(CITATION, ' ');
}

/**
 * Decoupe la reponse par reference, en s'appuyant sur le nom de cuvee puis sur
 * celui du domaine. Le segment qui precede la premiere reference est
 * l'introduction: on ne lui rattache aucune note, donc tout descripteur
 * sensoriel y est une anomalie.
 */
function segmenter(
  texte: string,
  resultats: readonly Resultat[],
): { reference: Resultat | null; segment: string }[] {
  const plat = normaliser(texte);

  const ancres = resultats
    .map((r) => {
      for (const marqueur of [r.nom_cuvee, r.domaine]) {
        const i = plat.indexOf(normaliser(marqueur));
        if (i !== -1) return { reference: r, index: i };
      }
      return null;
    })
    .filter((a): a is { reference: Resultat; index: number } => a !== null)
    .sort((a, b) => a.index - b.index);

  if (ancres.length === 0) return [{ reference: null, segment: texte }];

  const blocs: { reference: Resultat | null; segment: string }[] = [];
  if (ancres[0]!.index > 0) {
    blocs.push({ reference: null, segment: texte.slice(0, ancres[0]!.index) });
  }
  for (const [i, a] of ancres.entries()) {
    const fin = ancres[i + 1]?.index ?? texte.length;
    blocs.push({ reference: a.reference, segment: texte.slice(a.index, fin) });
  }
  return blocs;
}
