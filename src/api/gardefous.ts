import type pg from 'pg';
import { env } from '../config/env.js';

/**
 * Garde-fous budgetaires (§7 du brief).
 *
 * "Une demo publique sans garde-fou est le seul vrai risque financier du
 * projet." Les trois limites sont donc verifiees AVANT tout appel au modele,
 * jamais apres.
 *
 * Le compteur vit dans la table `recherches`, pas dans un Redis: ça couple le
 * rate limiting a la disponibilite de la base, mais ça evite une piece
 * d'infrastructure de plus pour une demo. A revoir si le trafic monte.
 */

export type Blocage =
  | { type: 'rate_limited'; message: string; retryApres: number }
  | { type: 'cap_budget'; message: string }
  | { type: 'message_trop_long'; message: string };

export async function verifierGardefous(
  pool: pg.Pool,
  ipHash: string,
  longueurMessage: number,
): Promise<Blocage | null> {
  const maxLongueur = env.maxLongueurMessage();
  if (longueurMessage > maxLongueur) {
    return {
      type: 'message_trop_long',
      message: `Message trop long : ${longueurMessage} caracteres, maximum ${maxLongueur}.`,
    };
  }

  // Une seule requete pour les deux compteurs.
  const { rows } = await pool.query<{ appels_ip: number; depense_jour: number }>(
    `SELECT
       count(*) FILTER (
         WHERE ip_hash = $1 AND created_at > now() - interval '1 hour'
       )::int AS appels_ip,
       COALESCE(sum(cout_eur) FILTER (
         WHERE created_at >= date_trunc('day', now())
       ), 0)::float AS depense_jour
     FROM recherches`,
    [ipHash],
  );

  const { appels_ip, depense_jour } = rows[0]!;

  const plafond = env.plafondEurParJour();
  if (depense_jour >= plafond) {
    return {
      type: 'cap_budget',
      message:
        `Plafond de depense quotidien atteint (${plafond.toFixed(2)} €). ` +
        `Le service repartira demain.`,
    };
  }

  const limite = env.rateLimitParIpParHeure();
  if (appels_ip >= limite) {
    return {
      type: 'rate_limited',
      message: `Trop de requetes : ${limite} par heure maximum.`,
      retryApres: 3600,
    };
  }

  return null;
}

export interface LigneJournal {
  ipHash: string;
  message: string;
  filtres: unknown;
  contraintesRelachees: string[];
  statut: string;
  cuveesRetournees: string[];
  providerLlm: string;
  tokensIn: number;
  tokensOut: number;
  coutEur: number;
  latenceMs: number;
}

/**
 * Journalise. Le message est conserve en clair (il sert a relire ce que le
 * systeme a compris), l'IP ne l'est jamais: seul un HMAC tronque est stocke.
 */
export async function journaliser(pool: pg.Pool, l: LigneJournal): Promise<void> {
  await pool.query(
    `INSERT INTO recherches
       (ip_hash, message, message_len, filtres, contraintes_relachees, statut,
        cuvees_retournees, provider_llm, tokens_in, tokens_out, cout_eur, latence_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      l.ipHash, l.message, l.message.length, JSON.stringify(l.filtres ?? null),
      l.contraintesRelachees, l.statut, l.cuveesRetournees, l.providerLlm,
      l.tokensIn, l.tokensOut, l.coutEur, l.latenceMs,
    ],
  );
}
