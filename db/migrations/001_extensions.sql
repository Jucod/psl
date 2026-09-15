-- Extensions. pgvector pour la partie floue, pg_trgm/unaccent pour la
-- tolerance orthographique sur les noms de domaines et de cuvees.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
