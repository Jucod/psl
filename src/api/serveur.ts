import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config } from '../config/domaine.js';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { executerPipeline, hashIp } from '../pipeline.js';
import { journaliser, verifierGardefous } from './gardefous.js';
import { publier } from './serialisation.js';

const ICI = dirname(fileURLToPath(import.meta.url));
const RACINE_WEB = join(ICI, '../../web/dist');

const app = Fastify({ logger: { level: 'info' } });

await app.register(cors, { origin: true });

/** Sert le front construit s'il existe. Absent en dev: Vite s'en charge. */
try {
  await app.register(fastifyStatic, { root: RACINE_WEB, prefix: '/' });
} catch {
  app.log.info('front non construit (web/dist absent) : API seule');
}

app.get('/api/sante', async () => {
  const { rows } = await db().query<{ cuvees: number; avec_note: number }>(
    `SELECT count(*)::int AS cuvees,
            count(*) FILTER (WHERE embedding_niveau = 'cuvee')::int AS avec_note
       FROM cuvees`,
  );
  return {
    ok: true,
    catalogue: rows[0],
    provider_llm: env.providerLlm(),
    provider_embedding: env.providerEmbedding(),
    fixtures_actives: env.autoriserFixtures(),
    max_resultats: config.maxResultats,
  };
});

/**
 * Metadonnees pour le panneau de filtres editable: le front ne doit pas
 * connaitre les valeurs du domaine en dur, il les demande.
 */
app.get('/api/catalogue', async () => {
  const pool = db();
  const [appellations, couleurs, cepages, bornes] = await Promise.all([
    pool.query(`SELECT a.id, a.nom, s.label AS source_label, s.url AS source_url
                  FROM appellations a JOIN sources s ON s.id = a.source_id ORDER BY a.nom`),
    pool.query(`SELECT DISTINCT couleur FROM appellation_couleurs ORDER BY couleur`),
    pool.query(`SELECT c.code, c.libelle FROM cepages c
                 WHERE EXISTS (SELECT 1 FROM cuvee_cepages cc WHERE cc.cepage = c.code)
                 ORDER BY c.libelle`),
    pool.query(`SELECT min(prix_ttc)::float AS prix_min, max(prix_ttc)::float AS prix_max,
                       min(millesime)::int AS millesime_min, max(millesime)::int AS millesime_max
                  FROM cuvees WHERE disponible`),
  ]);

  return {
    appellations: appellations.rows,
    couleurs: couleurs.rows.map((r) => r.couleur),
    cepages: cepages.rows,
    bornes: bornes.rows[0],
    champs: config.champs.map((c) => ({ cle: c.cle, libelle: c.libelle, operateur: c.operateur })),
    ordre_elargissement: config.ordreElargissement,
  };
});

interface CorpsRecherche {
  message?: unknown;
  filtres?: unknown;
}

app.post<{ Body: CorpsRecherche }>('/api/recherche', async (requete, reponse) => {
  const corps = requete.body ?? {};
  const message = typeof corps.message === 'string' ? corps.message : '';
  const ipHash = hashIp(requete.ip);
  const pool = db();

  const blocage = await verifierGardefous(pool, ipHash, message.length);
  if (blocage) {
    await journaliser(pool, {
      ipHash, message, filtres: null, contraintesRelachees: [], statut: blocage.type,
      cuveesRetournees: [], providerLlm: env.providerLlm(),
      tokensIn: 0, tokensOut: 0, coutEur: 0, latenceMs: 0,
    });
    if (blocage.type === 'rate_limited') reponse.header('retry-after', blocage.retryApres);
    return reponse
      .code(blocage.type === 'message_trop_long' ? 400 : 429)
      .send({ statut: blocage.type, texte: blocage.message, recherche: null });
  }

  // Un message vide est acceptable quand l'utilisateur a corrige les filtres a
  // la main dans le panneau: c'est ce cas qui court-circuite l'appel LLM 1.
  if (!message && corps.filtres === undefined) {
    return reponse.code(400).send({ statut: 'schema_invalide', texte: 'Message vide.', recherche: null });
  }

  const sortie = await executerPipeline({
    message,
    ...(corps.filtres !== undefined ? { filtresImposes: corps.filtres } : {}),
    ip: requete.ip,
  });

  for (const a of sortie.recherche?.avertissements ?? []) app.log.warn(a);

  await journaliser(pool, {
    ipHash,
    message,
    filtres: sortie.recherche?.filtresAppliques ?? null,
    contraintesRelachees: (sortie.recherche?.relachements ?? []).map((r) => r.annonce),
    statut: sortie.degrade ? 'degrade' : sortie.statut,
    cuveesRetournees: (sortie.recherche?.resultats ?? []).map((c) => c.id),
    providerLlm: sortie.providerLlm,
    tokensIn: sortie.usage.tokens_in,
    tokensOut: sortie.usage.tokens_out,
    coutEur: sortie.usage.cout_eur,
    latenceMs: sortie.latence_ms,
  });

  return {
    statut: sortie.statut,
    texte: sortie.texte,
    degrade: sortie.degrade,
    raison_degrade: sortie.raisonDegrade,
    fixtures_actives: sortie.fixturesActives,
    latence_ms: sortie.latence_ms,
    recherche: sortie.recherche ? publier(sortie.recherche) : null,
  };
});

const port = env.port();
await app.listen({ port, host: '0.0.0.0' });

if (env.autoriserFixtures()) {
  app.log.warn(
    '================================================================\n' +
    '  PSL_AUTORISER_FIXTURES=1 : des notes, prix et assemblages de\n' +
    '  DEVELOPPEMENT sont servis. Interdit sur une demo publique.\n' +
    '================================================================',
  );
}
app.log.info(`plafond ${env.plafondEurParJour()} €/jour · ${env.rateLimitParIpParHeure()} req/h/IP · message max ${env.maxLongueurMessage()} car.`);
