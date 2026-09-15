-- NE PAS APPLIQUER sous ~5 000 lignes.
--
-- Sous quelques milliers de lignes, ivfflat est plus lent qu'un seq scan ET
-- degrade le rappel en silence: il partitionne un espace quasi vide, et une
-- sonde peut manquer le plus proche voisin. A 5 cuvees, un
-- `ORDER BY embedding <=> $1 LIMIT 3` est exact et instantane.
--
-- Quand le volume le justifie: lists ~ sqrt(n) sous 1M de lignes, et
-- `SET ivfflat.probes = 10` au moment de la requete (sinon rappel ~ 1/lists).
-- L'index doit etre cree APRES le chargement des donnees, jamais avant.
--
-- Applique explicitement:  npm run db:migrate -- --avec-index-vectoriel
CREATE INDEX IF NOT EXISTS cuvees_embedding_idx ON cuvees
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 32);

CREATE INDEX IF NOT EXISTS appellation_profils_embedding_idx ON appellation_profils
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 1);
