/** Lecture centralisee de l'environnement, avec des defauts surs. */

function nombre(cle: string, defaut: number): number {
  const v = process.env[cle];
  if (v === undefined || v === '') return defaut;
  const n = Number(v);
  return Number.isFinite(n) ? n : defaut;
}

function booleen(cle: string, defaut: boolean): boolean {
  const v = process.env[cle];
  if (v === undefined || v === '') return defaut;
  return v === '1' || v.toLowerCase() === 'true';
}

export const env = {
  databaseUrl: () => process.env.DATABASE_URL ?? 'postgres://psl:psl@127.0.0.1:5432/psl',

  providerEmbedding: () => process.env.PSL_EMBEDDING_PROVIDER ?? 'local',
  providerLlm: () => process.env.PSL_LLM_PROVIDER ?? 'local',
  modeleLlm: () => process.env.PSL_LLM_MODELE ?? 'claude-sonnet-5',

  maxLongueurMessage: () => nombre('PSL_MAX_LONGUEUR_MESSAGE', 400),
  rateLimitParIpParHeure: () => nombre('PSL_RATE_LIMIT_PAR_IP_PAR_HEURE', 20),
  plafondEurParJour: () => nombre('PSL_PLAFOND_EUR_PAR_JOUR', 2),
  ipHashSecret: () => process.env.PSL_IP_HASH_SECRET ?? 'dev-secret-non-sur',

  /**
   * Defaut a FALSE, volontairement. Une demo publique deployee sans toucher a
   * l'environnement ne sert aucune donnee de developpement.
   */
  autoriserFixtures: () => booleen('PSL_AUTORISER_FIXTURES', false),

  port: () => nombre('PORT', 3000),
} as const;
