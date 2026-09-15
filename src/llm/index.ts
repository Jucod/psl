import { env } from '../config/env.js';
import type { Filtres } from '../schema/filtres.js';
import type { ResultatRecherche } from '../moteur/types.js';
import { LlmLocal } from './local.js';
import { LlmAnthropic } from './anthropic.js';

export interface Usage {
  tokens_in: number;
  tokens_out: number;
  cout_eur: number;
}

export interface ResultatExtraction {
  filtres: Filtres;
  /** Vrai quand le modele a echoue et qu'on est retombe sur le parseur regle. */
  degrade: boolean;
  /** Raison du passage en degrade, pour le journal et l'UI. */
  raisonDegrade: string | null;
  usage: Usage;
}

export interface FournisseurLlm {
  readonly nom: string;
  /** Appel 1: langage naturel -> filtres valides contre le schema strict. */
  extraireFiltres(message: string, appellationParDefaut: string | null): Promise<ResultatExtraction>;
  /** Appel 2: lignes retournees -> texte. Voir la contrainte de type ci-dessous. */
  formuler(entree: EntreeFormulation): Promise<{ texte: string; usage: Usage }>;
}

/**
 * Entree de l'appel 2.
 *
 * Ce type est une BARRIERE, pas une commodite: il ne contient ni le message de
 * l'utilisateur, ni les descripteurs extraits. C'est ce qui rend inoperant
 * "decris-moi ce vin comme une soiree d'ete": le registre demande n'a aucun
 * chemin jusqu'au prompt de formulation. Ne pas ajouter de champ de texte
 * libre ici sans relire le §7 du brief (loi Evin).
 */
export interface EntreeFormulation {
  readonly recherche: Omit<ResultatRecherche, 'filtresDemandes' | 'filtresAppliques'> & {
    readonly filtresAppliques: Readonly<Record<string, unknown>>;
  };
}

export function fournisseurLlm(): FournisseurLlm {
  const nom = env.providerLlm();
  switch (nom) {
    case 'local':
      return new LlmLocal();
    case 'anthropic':
      return new LlmAnthropic(env.modeleLlm());
    default:
      throw new Error(`PSL_LLM_PROVIDER="${nom}" inconnu. Valeurs: local, anthropic.`);
  }
}

export const USAGE_NUL: Usage = Object.freeze({ tokens_in: 0, tokens_out: 0, cout_eur: 0 });
