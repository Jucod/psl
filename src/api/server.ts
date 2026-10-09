import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { COLOR_LABELS, config } from '../config/domain.js';
import { env } from '../config/env.js';
import { DISHES, FAMILIES } from '../config/lexicon.js';
import { db } from '../db/client.js';
import { hashIp, runPipeline } from '../pipeline.js';
import { checkGuardrails, logSearch } from './guardrails.js';
import { toPublic } from './serialization.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, '../../web/dist');

const app = Fastify({ logger: { level: 'info' } });

// CORS: an open origin lets a third-party page burn through the daily spending
// cap. Per-IP rate limiting mitigates that without cancelling it.
// Same origin only by default; PSL_ALLOWED_ORIGINS opens it up when needed.
const origins = env.allowedOrigins();
await app.register(cors, { origin: origins.length > 0 ? origins : false });

/** Serves the built front end when it exists. Absent in dev: Vite takes care of it. */
try {
  await app.register(fastifyStatic, { root: WEB_ROOT, prefix: '/' });
} catch {
  app.log.info('front end not built (web/dist missing): API only');
}

app.get('/api/health', async () => {
  // Counting notes regardless of the flag announced "5 wines with a note"
  // next to "fixtures_enabled: false".
  const { rows } = await db().query<{ wines: number; with_note: number }>(
    `SELECT count(*)::int AS wines,
            count(*) FILTER (
              WHERE embedding_level = 'wine'
                AND ($1::boolean OR NOT from_fixture)
            )::int AS with_note
       FROM wines`,
    [env.allowFixtures()],
  );
  return {
    ok: true,
    catalog: rows[0],
    llm_provider: env.llmProvider(),
    embedding_provider: env.embeddingProvider(),
    fixtures_enabled: env.allowFixtures(),
    max_results: config.maxResults,
  };
});

/**
 * Metadata for the editable filter panel: the front end must not hard-code
 * the domain's values, it asks for them. That includes the French display
 * labels of the codes used in filters and results.
 *
 * The same fixture predicate as the engine applies here. Without it, the
 * budget slider showed a 14-26 € range and three grape varieties entirely
 * taken from the development overlay, with the flag at 0: the left panel
 * contradicted the answer on the right, in the same second.
 */
app.get('/api/catalog', async () => {
  const pool = db();
  const fixtures = env.allowFixtures();
  const [appellations, colors, grapes, bounds] = await Promise.all([
    pool.query(`SELECT a.id, a.name, a.tier, s.label AS source_label, s.url AS source_url
                  FROM appellations a JOIN sources s ON s.id = a.source_id
                 ORDER BY array_position(ARRAY['aop','igp','vsig'], a.tier), a.name`),
    pool.query(`SELECT DISTINCT color FROM appellation_colors ORDER BY color`),
    pool.query(`SELECT g.code, g.label FROM grapes g
                 WHERE EXISTS (
                   SELECT 1 FROM wine_grapes wg
                     JOIN wines w ON w.id = wg.wine_id
                    WHERE wg.grape = g.code
                      AND ($1::boolean OR NOT w.from_fixture)
                 )
                 ORDER BY g.label`, [fixtures]),
    pool.query(`SELECT min(price_eur)::float AS price_min, max(price_eur)::float AS price_max,
                       min(vintage)::int AS vintage_min, max(vintage)::int AS vintage_max
                  FROM wines
                 WHERE available AND ($1::boolean OR NOT from_fixture)`, [fixtures]),
  ]);

  const labelsOf = (entries: Record<string, { readonly label: string }>) =>
    Object.fromEntries(Object.entries(entries).map(([code, e]) => [code, e.label]));

  return {
    appellations: appellations.rows,
    colors: colors.rows.map((r) => r.color),
    grapes: grapes.rows,
    bounds: bounds.rows[0],
    fields: config.fields.map((f) => ({ key: f.key, label: f.label, operator: f.operator })),
    relaxation_order: config.relaxationOrder,
    labels: {
      colors: Object.fromEntries(
        Object.entries(COLOR_LABELS).map(([code, l]) => [code, l.singular]),
      ),
      descriptors: labelsOf(FAMILIES),
      dishes: labelsOf(DISHES),
    },
  };
});

interface SearchBody {
  message?: unknown;
  filters?: unknown;
}

app.post<{ Body: SearchBody }>('/api/search', async (request, reply) => {
  const body = request.body ?? {};
  const message = typeof body.message === 'string' ? body.message : '';
  const ipHash = hashIp(request.ip);
  const pool = db();

  const block = await checkGuardrails(pool, ipHash, message.length);
  if (block) {
    await logSearch(pool, {
      ipHash, message, filters: null, relaxedConstraints: [], status: block.type,
      returnedWineIds: [], llmProvider: env.llmProvider(),
      tokensIn: 0, tokensOut: 0, costEur: 0, latencyMs: 0,
    });
    if (block.type === 'rate_limited') reply.header('retry-after', block.retryAfter);
    return reply
      .code(block.type === 'message_too_long' ? 400 : 429)
      .send({ status: block.type, text: block.message, search: null });
  }

  // An empty message is acceptable when the user corrected the filters by
  // hand in the panel: that is the case that bypasses LLM call 1.
  if (!message && body.filters === undefined) {
    return reply.code(400).send({ status: 'invalid_schema', text: 'Message vide.', search: null });
  }

  const output = await runPipeline({
    message,
    ...(body.filters !== undefined ? { forcedFilters: body.filters } : {}),
    ip: request.ip,
  });

  for (const warning of output.search?.warnings ?? []) app.log.warn(warning);

  await logSearch(pool, {
    ipHash,
    message,
    filters: output.search?.appliedFilters ?? null,
    relaxedConstraints: (output.search?.relaxations ?? []).map((r) => r.announcement),
    status: output.degraded ? 'degraded' : output.status,
    returnedWineIds: (output.search?.results ?? []).map((w) => w.id),
    llmProvider: output.llmProvider,
    tokensIn: output.usage.tokens_in,
    tokensOut: output.usage.tokens_out,
    costEur: output.usage.cost_eur,
    latencyMs: output.latency_ms,
  });

  return {
    status: output.status,
    text: output.text,
    degraded: output.degraded,
    degraded_reason: output.degradedReason,
    fixtures_enabled: output.fixturesEnabled,
    latency_ms: output.latency_ms,
    search: output.search ? toPublic(output.search) : null,
  };
});

const port = env.port();
await app.listen({ port, host: '0.0.0.0' });

if (env.allowFixtures()) {
  app.log.warn(
    '================================================================\n' +
    '  PSL_ALLOW_FIXTURES=1: DEVELOPMENT notes, prices and blends are\n' +
    '  being served. Forbidden on a public demo.\n' +
    '================================================================',
  );
}
app.log.info(`cap ${env.dailyBudgetEur()} €/day · ${env.rateLimitPerIpPerHour()} req/h/IP · message max ${env.maxMessageLength()} chars`);
