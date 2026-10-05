-- Fingerprint of the configuration used to compute the stored vectors.
--
-- Why it exists: changing the lexicon (src/config/lexicon.ts) changes how
-- notes are vectorized, but the vectors already in the database do not move.
-- Ranking keeps working, on stale data, with no signal whatsoever. It is the
-- kind of failure you do not see, and that costs an evening spent looking for
-- a bug somewhere else.
CREATE TABLE embedding_state (
  key         text PRIMARY KEY,
  signature   text NOT NULL,
  provider    text NOT NULL,
  dimension   int  NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
