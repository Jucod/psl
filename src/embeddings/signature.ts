import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import type { FournisseurEmbedding } from './index.js';

const CHEMIN_LEXIQUE = fileURLToPath(new URL('../config/lexique.ts', import.meta.url));

/**
 * Empreinte de tout ce qui influence la valeur d'un vecteur: le provider, la
 * dimension, et le lexique (qui pilote l'expansion en familles du provider
 * local). Si l'un des trois bouge, les vecteurs stockes ne sont plus
 * comparables a un vecteur de requete calcule maintenant.
 */
export async function signatureEmbedding(f: FournisseurEmbedding): Promise<string> {
  const lexique = await readFile(CHEMIN_LEXIQUE, 'utf8');
  return createHash('sha256')
    .update(`${f.nom}:${f.dimension}:`)
    .update(createHash('sha256').update(lexique).digest('hex'))
    .digest('hex')
    .slice(0, 32);
}

export async function enregistrerSignature(
  client: pg.Pool | pg.PoolClient,
  f: FournisseurEmbedding,
): Promise<string> {
  const signature = await signatureEmbedding(f);
  await client.query(
    `INSERT INTO embedding_etat (cle, signature, provider, dimension, calcule_le)
     VALUES ('cuvees', $1, $2, $3, now())
     ON CONFLICT (cle) DO UPDATE SET
       signature = EXCLUDED.signature, provider = EXCLUDED.provider,
       dimension = EXCLUDED.dimension, calcule_le = now()`,
    [signature, f.nom, f.dimension],
  );
  return signature;
}

export interface EtatEmbedding {
  aJour: boolean;
  message: string | null;
}

/**
 * Verifie que les vecteurs stockes ont ete calcules avec la configuration
 * courante. En cas d'ecart, le moteur refuse de classer au vectoriel plutot
 * que de produire un ordre faux avec l'air d'aller bien.
 */
export async function verifierSignature(
  client: pg.Pool | pg.PoolClient,
  f: FournisseurEmbedding,
): Promise<EtatEmbedding> {
  const attendue = await signatureEmbedding(f);
  const { rows } = await client.query<{ signature: string; provider: string; calcule_le: Date }>(
    `SELECT signature, provider, calcule_le FROM embedding_etat WHERE cle = 'cuvees'`,
  );

  if (rows.length === 0) {
    return { aJour: false, message: 'aucun embedding calcule. Lance: npm run db:embed' };
  }
  if (rows[0]!.signature !== attendue) {
    return {
      aJour: false,
      message:
        `les vecteurs en base datent du ${rows[0]!.calcule_le.toISOString().slice(0, 16)} ` +
        `et ont ete calcules avec une autre configuration (provider ou lexique modifie). ` +
        `Classement vectoriel desactive. Relance: npm run db:embed`,
    };
  }
  return { aJour: true, message: null };
}
