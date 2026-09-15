import {
  CEPAGES_HORS_APPELLATION, FAMILLE_PAR_MOT, FAMILLES, MARQUEURS_NEGATION,
  OPPOSES, PLATS, PORTEE_NEGATION, mots, normaliser, racine,
} from '../config/lexique.js';
import { FILTRES_VIDES, FiltresSchema, type Filtres } from '../schema/filtres.js';

/**
 * Parseur deterministe francais -> filtres.
 *
 * Deux roles:
 *  - provider LLM "local", pour faire tourner le prototype sans cle API;
 *  - MODE DEGRADE du provider reel, quand le modele rend deux fois de suite
 *    une sortie qui ne valide pas le schema strict.
 *
 * Le brief laissait ce mode degrade indefini (§4). Le voici: pas de reponse
 * vague, un parsing par regles annonce comme tel dans l'UI.
 */

export interface OptionsParseur {
  appellationParDefaut?: string | null;
  /** code de cepage -> synonymes normalises, pour reconnaitre "shiraz". */
  indexCepages?: ReadonlyMap<string, string>;
}

const RE_PRIX_MAX = /(?:moins de|jusqu'?a|max(?:imum)?|sous|budget de|autour de|environ|vers)\s*(\d+(?:[.,]\d+)?)\s*(?:€|eur|euros?)?/i;
const RE_PRIX_NU = /(\d+(?:[.,]\d+)?)\s*(?:€|eur|euros?)/i;
const RE_PRIX_MIN = /(?:plus de|a partir de|mini(?:mum)?|au moins)\s*(\d+(?:[.,]\d+)?)\s*(?:€|eur|euros?)?/i;
const RE_MILLESIME = /\b(19[5-9]\d|20[0-4]\d)\b/g;

export function parser(message: string, options: OptionsParseur = {}): Filtres {
  const texte = normaliser(message);
  const brut: Record<string, unknown> = { ...FILTRES_VIDES };

  const decoupe = mots(message);

  // --- couleur -------------------------------------------------------------
  // Trois pieges, tous rencontres:
  //  - "blanche" n'est pas "blanc": une viande blanche declenchait un refus
  //    d'appellation, confiant, explicite et source. Le pire mode de panne.
  //  - "un rouge pour une viande blanche": le rouge est le sujet, il prime.
  //  - "surtout pas un blanc": la couleur doit passer par la negation comme
  //    les cepages et les descripteurs.
  const COULEURS: [string, RegExp][] = [
    ['rouge', /\brouges?\b/],
    ['rose', /\bros[ée]e?s?\b/],
    ['blanc', /\bblancs?\b/],
  ];
  for (const [code, motif] of COULEURS) {
    const m = motif.exec(texte);
    if (!m) continue;
    const position = texte.slice(0, m.index).split(/\s+/).length - 1;
    if (estNie(decoupe.brut, position)) continue;
    brut.couleur = code;
    break;
  }

  // --- prix ----------------------------------------------------------------
  const min = RE_PRIX_MIN.exec(texte);
  if (min) brut.prix_min = Number(min[1]!.replace(',', '.'));

  const max = RE_PRIX_MAX.exec(texte);
  if (max) {
    brut.prix_max = Number(max[1]!.replace(',', '.'));
  } else {
    const nu = RE_PRIX_NU.exec(texte);
    // Un montant nu est lu comme un plafond: c'est la lecture la plus
    // frequente d'un budget exprime en conversation.
    if (nu && brut.prix_min === null) brut.prix_max = Number(nu[1]!.replace(',', '.'));
  }

  // --- millesime -----------------------------------------------------------
  const annees = [...texte.matchAll(RE_MILLESIME)].map((m) => Number(m[1]));
  if (annees.length === 1) {
    brut.millesime_min = annees[0];
    brut.millesime_max = annees[0];
  } else if (annees.length >= 2) {
    brut.millesime_min = Math.min(...annees);
    brut.millesime_max = Math.max(...annees);
  }

  // --- bio -----------------------------------------------------------------
  if (/\bbio\b|\bbiologique\b|\bagriculture biologique\b/.test(texte)) brut.bio = true;

  // --- cepages -------------------------------------------------------------
  if (options.indexCepages) {
    const parRacine = new Map<string, string>();
    for (const [synonyme, code] of options.indexCepages) {
      if (synonyme.length < 4) continue;
      parRacine.set(synonyme.split(' ').map(racine).join(' '), code);
    }
    // Les cepages hors appellation sont reconnus DELIBEREMENT, pour que la
    // demande produise un refus source plutot que de s'evaporer.
    for (const hors of CEPAGES_HORS_APPELLATION) {
      parRacine.set(hors.split(' ').map(racine).join(' '), hors);
    }

    const inclus = new Set<string>();
    const exclus = new Set<string>();
    for (const { cle, position } of sequences(decoupe.racines)) {
      const code = parRacine.get(cle);
      if (!code) continue;
      (estNie(decoupe.brut, position) ? exclus : inclus).add(code);
    }
    brut.cepages_inclus = [...inclus].filter((c) => !exclus.has(c)).sort();
    brut.cepages_exclus = [...exclus].sort();
  }

  // --- plat ----------------------------------------------------------------
  for (const [cle, def] of Object.entries(PLATS)) {
    if (def.termes.some((t) => texte.includes(normaliser(t)))) {
      brut.plat = cle;
      break;
    }
  }

  // --- descripteurs, avec resolution explicite de la negation ---------------
  const descripteurs = new Set<string>();
  const exclus = new Set<string>();
  for (const { cle, position } of sequences(decoupe.racines)) {
    const famille = FAMILLE_PAR_MOT.get(cle);
    if (!famille) continue;
    if (estNie(decoupe.brut, position)) {
      // Deux effets distincts, et les deux comptent: on veut l'oppose, ET on
      // veut penaliser ce qui est refuse. Se contenter de l'oppose ne
      // departage pas des notes qui contiennent toutes le terme nie.
      exclus.add(famille);
      const oppose = OPPOSES[famille];
      if (oppose) descripteurs.add(oppose);
    } else {
      descripteurs.add(famille);
    }
  }
  brut.descripteurs = [...descripteurs].filter((d) => !exclus.has(d)).sort().slice(0, 8);
  brut.descripteurs_exclus = [...exclus].sort().slice(0, 8);

  // --- appellation ---------------------------------------------------------
  if (options.appellationParDefaut) brut.appellation = options.appellationParDefaut;

  const parsed = FiltresSchema.safeParse(brut);
  if (!parsed.success) {
    // Le parseur de repli ne doit jamais etre la cause d'une panne: on retombe
    // sur des filtres vides plutot que de propager une erreur.
    return { ...FILTRES_VIDES, appellation: options.appellationParDefaut ?? null };
  }
  return parsed.data;
}

/**
 * Enumere les unigrammes et bigrammes du message avec leur position.
 * Le bigramme est teste en premier: "fruits rouges" doit primer sur "rouges".
 */
function* sequences(racines: string[]): Generator<{ cle: string; position: number }> {
  for (let i = 0; i < racines.length; i++) {
    if (i + 1 < racines.length) yield { cle: `${racines[i]} ${racines[i + 1]}`, position: i };
    yield { cle: racines[i]!, position: i };
  }
}

/** Un marqueur de negation figure-t-il dans les mots qui precedent ? */
function estNie(brut: string[], position: number): boolean {
  for (let i = Math.max(0, position - PORTEE_NEGATION); i < position; i++) {
    if (MARQUEURS_NEGATION.has(brut[i]!)) return true;
  }
  return false;
}

/**
 * Textes a embedder pour la partie floue.
 *
 * Chaque famille est re-developpee en ses membres: le vecteur de requete couvre
 * tout le champ lexical, pas seulement le mot-cle saisi.
 */
export function texteVectoriel(filtres: Filtres): { inclus: string; exclus: string | null } | null {
  if (filtres.descripteurs.length === 0 && filtres.descripteurs_exclus.length === 0) return null;
  const developper = (liste: string[]) => liste.flatMap((d) => FAMILLES[d] ?? [d]).join(' ');
  return {
    inclus: developper(filtres.descripteurs),
    exclus: filtres.descripteurs_exclus.length ? developper(filtres.descripteurs_exclus) : null,
  };
}
