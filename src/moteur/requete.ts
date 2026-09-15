import { champParCle, config, type ChampFiltre } from '../config/domaine.js';
import type { Filtres } from '../schema/filtres.js';

export interface ClauseSql {
  texte: string;
  params: unknown[];
}

/**
 * Traduit un objet de filtres en clauses SQL, en se pilotant UNIQUEMENT sur
 * src/config/domaine.ts. Aucun nom de colonne metier n'apparait ici: changer de
 * domaine = changer la config, pas ce fichier.
 */
export function construireClauses(
  filtres: Filtres,
  premierParam: number,
): ClauseSql {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let n = premierParam;

  for (const champ of config.champs) {
    const valeur = (filtres as Record<string, unknown>)[champ.cle];
    if (valeur === null || valeur === undefined) continue;
    if (Array.isArray(valeur) && valeur.length === 0) continue;

    const clause = clausePourChamp(champ, valeur, () => `$${n++}`, params);
    if (clause) clauses.push(clause);
  }

  return {
    texte: clauses.length ? clauses.join(' AND ') : 'TRUE',
    params,
  };
}

function clausePourChamp(
  champ: ChampFiltre,
  valeur: unknown,
  prochainParam: () => string,
  params: unknown[],
): string | null {
  switch (champ.operateur) {
    case 'egal':
      params.push(valeur);
      return `c.${champ.colonne} = ${prochainParam()}`;

    case 'max':
      params.push(valeur);
      // Une valeur NULL n'est pas "sous le budget": elle est inconnue.
      // On l'exclut plutot que de la faire passer pour conforme.
      return `c.${champ.colonne} IS NOT NULL AND c.${champ.colonne} <= ${prochainParam()}`;

    case 'min':
      params.push(valeur);
      return `c.${champ.colonne} IS NOT NULL AND c.${champ.colonne} >= ${prochainParam()}`;

    case 'booleen':
      // false = "peu importe", pas "surtout pas". Demander explicitement du
      // non-bio n'a pas de sens cote utilisateur.
      return valeur === true ? `c.${champ.colonne} IS TRUE` : null;

    case 'jointure_un': {
      const j = champ.jointure!;
      params.push(valeur);
      return `EXISTS (SELECT 1 FROM ${j.table} jj WHERE jj.${j.cleEtrangere} = c.id AND jj.${j.colonne} = ANY(${prochainParam()}))`;
    }

    case 'jointure_aucun': {
      const j = champ.jointure!;
      params.push(valeur);
      return `NOT EXISTS (SELECT 1 FROM ${j.table} jj WHERE jj.${j.cleEtrangere} = c.id AND jj.${j.colonne} = ANY(${prochainParam()}))`;
    }

    default: {
      const _exhaustif: never = champ.operateur;
      throw new Error(`operateur non gere: ${_exhaustif}`);
    }
  }
}

export function libelleChamp(cle: string): string {
  return champParCle.get(cle)?.libelle ?? cle;
}
