import { FAMILLE_PAR_MOT, tokeniser } from '../config/lexique.js';
import type { FournisseurEmbedding } from './index.js';

/**
 * Provider d'embedding deterministe, hors ligne, sans cle API.
 *
 * Ce n'est pas un modele: c'est un sac de mots projete par hachage signe
 * ("hashing trick"), enrichi des familles de descripteurs declarees dans
 * src/config/lexique.ts. Le lexique fait le travail qu'un modele pre-entraine
 * ferait autrement: rapprocher "souple" de "fondu" et de "soyeux".
 *
 * Pourquoi ça suffit ici: le corpus fait quelques centaines de notes de
 * degustation, un vocabulaire etroit et tres code. Sur ce terrain un sac de
 * mots synonymise se comporte honorablement, il est instantane, il ne coute
 * rien et il est reproductible au bit pres, ce qui rend les tests de
 * classement deterministes.
 *
 * Ses limites, a connaitre: aucune comprehension de la negation ("pas
 * tannique" et "tannique" partagent la meme dimension), aucune notion d'ordre,
 * aucune generalisation hors lexique. Basculer sur un vrai modele
 * (PSL_EMBEDDING_PROVIDER=openai) des que le corpus depasse le lexique.
 * La negation est traitee en amont, par le parseur de filtres, qui la
 * transforme en contrainte explicite plutot qu'en signal vectoriel.
 */
export class EmbeddingLocal implements FournisseurEmbedding {
  readonly nom = 'local';
  readonly deterministe = true;

  /** Un token de famille pese plus que sa forme de surface: la synonymie prime. */
  private static readonly POIDS_SURFACE = 1.0;
  private static readonly POIDS_FAMILLE = 1.6;

  constructor(readonly dimension: number) {}

  async embed(textes: readonly string[]): Promise<number[][]> {
    return textes.map((t) => this.vecteur(t));
  }

  vecteur(texte: string): number[] {
    const v = new Array<number>(this.dimension).fill(0);
    const tokens = tokeniser(texte);

    for (const token of tokens) {
      this.ajouter(v, token, EmbeddingLocal.POIDS_SURFACE);
      const famille = FAMILLE_PAR_MOT.get(token);
      if (famille) this.ajouter(v, `famille:${famille}`, EmbeddingLocal.POIDS_FAMILLE);
    }

    let somme = 0;
    for (const x of v) somme += x * x;
    const norme = Math.sqrt(somme);
    if (norme === 0) return v;
    return v.map((x) => x / norme);
  }

  private ajouter(v: number[], token: string, poids: number): void {
    const h = fnv1a(token);
    const index = h % this.dimension;
    // Second hachage pour le signe: limite les collisions constructives.
    const signe = fnv1a(`${token}#signe`) % 2 === 0 ? 1 : -1;
    v[index] = (v[index] ?? 0) + signe * poids;
  }
}

/** FNV-1a 32 bits. Stable entre versions de Node, contrairement a un hash natif. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
