-- DO NOT APPLY below ~5,000 rows.
--
-- Below a few thousand rows, ivfflat is slower than a seq scan AND silently
-- degrades recall: it partitions an almost empty space, and a probe can miss
-- the nearest neighbor. With a handful of wines, an
-- `ORDER BY embedding <=> $1 LIMIT 3` is exact and instantaneous.
--
-- When the volume justifies it: lists ~ sqrt(n) below 1M rows, and
-- `SET ivfflat.probes = 10` at query time (otherwise recall ~ 1/lists).
-- The index must be created AFTER the data is loaded, never before.
--
-- Applied explicitly:  npm run db:migrate -- --with-vector-index
CREATE INDEX IF NOT EXISTS wines_embedding_idx ON wines
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 32);

CREATE INDEX IF NOT EXISTS appellation_profiles_embedding_idx ON appellation_profiles
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 1);
