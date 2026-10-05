-- Appellation reference data. Payloads that are never filtered on (communes,
-- grape rules, production, terroir) stay in jsonb: six tables nobody queries
-- are not worth their maintenance cost.
CREATE TABLE appellations (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  status          text,
  region          text,
  recognized_year smallint,
  communes        jsonb NOT NULL DEFAULT '{}'::jsonb,
  grape_rules     jsonb NOT NULL DEFAULT '{}'::jsonb,
  production      jsonb NOT NULL DEFAULT '{}'::jsonb,
  terroir         jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_id       text NOT NULL REFERENCES sources(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Colors ACTUALLY permitted by the appellation's specification.
-- This table is what produces the refusal "the Pic Saint-Loup AOC only covers
-- reds and roses". The refusal is a query result, not a prompt instruction:
-- it can be tested without any LLM call.
CREATE TABLE appellation_colors (
  appellation_id text NOT NULL REFERENCES appellations(id) ON DELETE CASCADE,
  color          text NOT NULL CHECK (color IN ('red','rose','white')),
  PRIMARY KEY (appellation_id, color)
);

-- Official sensory profile, per color. Citable source (INAO).
-- Serves as the embedding fallback when a wine has no producer note.
CREATE TABLE appellation_profiles (
  appellation_id  text NOT NULL,
  color           text NOT NULL,
  appearance      text,
  aromas          text[] NOT NULL DEFAULT '{}',
  palate          text,
  structure       text,
  aging_potential text,
  profile_text    text NOT NULL,
  embedding       vector(1536),
  source_id       text NOT NULL REFERENCES sources(id),
  source_section  text,
  PRIMARY KEY (appellation_id, color),
  FOREIGN KEY (appellation_id, color)
    REFERENCES appellation_colors(appellation_id, color) ON DELETE CASCADE
);

-- Food pairings: DERIVED from the profile, never source data.
-- The CHECK structurally forbids promoting them to an established fact.
CREATE TABLE appellation_pairings (
  id             bigserial PRIMARY KEY,
  appellation_id text NOT NULL,
  color          text NOT NULL,
  category       text NOT NULL CHECK (category IN ('meat','cheese','fish','other')),
  label          text NOT NULL,
  status         text NOT NULL DEFAULT 'derived' CHECK (status = 'derived'),
  derived_from   text NOT NULL,
  UNIQUE (appellation_id, color, category, label),
  FOREIGN KEY (appellation_id, color)
    REFERENCES appellation_colors(appellation_id, color) ON DELETE CASCADE
);

CREATE INDEX appellation_pairings_lookup_idx
  ON appellation_pairings (appellation_id, color, category);
