-- Extensions. pgvector for the fuzzy part of a request, pg_trgm/unaccent for
-- spelling tolerance on producer and wine names.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
