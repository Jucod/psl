-- Search log. Serves three purposes at once: per-IP rate limiting, the daily
-- spending cap, and demo evidence (what the system understood, what it
-- relaxed, what it refused).
-- This couples the rate limiter to the database's availability; acceptable for
-- a demo, and it avoids a Redis. To revisit if traffic grows.
CREATE TABLE searches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_hash             text,
  message             text,
  message_len         int NOT NULL,
  filters             jsonb,
  relaxed_constraints text[] NOT NULL DEFAULT '{}',
  status              text NOT NULL CHECK (status IN (
                        'ok',
                        'refused',
                        'empty',
                        'degraded',
                        'invalid_schema',
                        'rate_limited',
                        'budget_cap',
                        'message_too_long'
                      )),
  returned_wine_ids   text[] NOT NULL DEFAULT '{}',
  llm_provider        text,
  tokens_in           int,
  tokens_out          int,
  cost_eur            numeric(10,6) NOT NULL DEFAULT 0,
  latency_ms          int,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX searches_day_idx ON searches (created_at DESC);
CREATE INDEX searches_ip_idx  ON searches (ip_hash, created_at DESC);
