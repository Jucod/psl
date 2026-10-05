import type pg from 'pg';
import { env } from '../config/env.js';

/**
 * Budget guardrails (§7 of the brief).
 *
 * "A public demo without a guardrail is the only real financial risk of the
 * project." The three limits are therefore checked BEFORE any model call,
 * never after.
 *
 * The counter lives in the `searches` table, not in a Redis: it couples rate
 * limiting to the database's availability, but it avoids one more piece of
 * infrastructure for a demo. To revisit if traffic grows.
 *
 * Messages are shown to the visitor, hence in French.
 */

export type Block =
  | { type: 'rate_limited'; message: string; retryAfter: number }
  | { type: 'budget_cap'; message: string }
  | { type: 'message_too_long'; message: string };

export async function checkGuardrails(
  pool: pg.Pool,
  ipHash: string,
  messageLength: number,
): Promise<Block | null> {
  const maxLength = env.maxMessageLength();
  if (messageLength > maxLength) {
    return {
      type: 'message_too_long',
      message: `Message trop long : ${messageLength} caracteres, maximum ${maxLength}.`,
    };
  }

  // A single query for both counters.
  const { rows } = await pool.query<{ ip_calls: number; spent_today: number }>(
    `SELECT
       count(*) FILTER (
         WHERE ip_hash = $1 AND created_at > now() - interval '1 hour'
       )::int AS ip_calls,
       COALESCE(sum(cost_eur) FILTER (
         WHERE created_at >= date_trunc('day', now())
       ), 0)::float AS spent_today
     FROM searches`,
    [ipHash],
  );

  const { ip_calls, spent_today } = rows[0]!;

  const cap = env.dailyBudgetEur();
  if (spent_today >= cap) {
    return {
      type: 'budget_cap',
      message:
        `Plafond de depense quotidien atteint (${cap.toFixed(2)} €). ` +
        `Le service repartira demain.`,
    };
  }

  const limit = env.rateLimitPerIpPerHour();
  if (ip_calls >= limit) {
    return {
      type: 'rate_limited',
      message: `Trop de requetes : ${limit} par heure maximum.`,
      retryAfter: 3600,
    };
  }

  return null;
}

export interface LogEntry {
  ipHash: string;
  message: string;
  filters: unknown;
  relaxedConstraints: string[];
  status: string;
  returnedWineIds: string[];
  llmProvider: string;
  tokensIn: number;
  tokensOut: number;
  costEur: number;
  latencyMs: number;
}

/**
 * Logs a search. The message is kept in clear text (it is used to re-read
 * what the system understood), the IP never is: only a truncated HMAC is
 * stored.
 */
export async function logSearch(pool: pg.Pool, e: LogEntry): Promise<void> {
  await pool.query(
    `INSERT INTO searches
       (ip_hash, message, message_len, filters, relaxed_constraints, status,
        returned_wine_ids, llm_provider, tokens_in, tokens_out, cost_eur, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      e.ipHash, e.message, e.message.length, JSON.stringify(e.filters ?? null),
      e.relaxedConstraints, e.status, e.returnedWineIds, e.llmProvider,
      e.tokensIn, e.tokensOut, e.costEur, e.latencyMs,
    ],
  );
}
