/** Centralized reading of the environment, with safe defaults. */

function numberVar(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function booleanVar(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

export const env = {
  databaseUrl: () => process.env.DATABASE_URL ?? 'postgres://psl:psl@127.0.0.1:5432/psl',

  embeddingProvider: () => process.env.PSL_EMBEDDING_PROVIDER ?? 'local',
  llmProvider: () => process.env.PSL_LLM_PROVIDER ?? 'local',
  llmModel: () => process.env.PSL_LLM_MODEL ?? 'claude-sonnet-5',

  maxMessageLength: () => numberVar('PSL_MAX_MESSAGE_LENGTH', 400),
  rateLimitPerIpPerHour: () => numberVar('PSL_RATE_LIMIT_PER_IP_PER_HOUR', 20),
  dailyBudgetEur: () => numberVar('PSL_DAILY_BUDGET_EUR', 2),
  ipHashSecret: () => process.env.PSL_IP_HASH_SECRET ?? 'insecure-dev-secret',

  /**
   * Defaults to FALSE, on purpose. A public demo deployed without touching
   * the environment serves no development data.
   */
  allowFixtures: () => booleanVar('PSL_ALLOW_FIXTURES', false),

  port: () => numberVar('PORT', 3000),
} as const;
