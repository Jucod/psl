CREATE TABLE producers (
  id                text PRIMARY KEY,
  name              text NOT NULL,
  commune           text,
  department        text,
  type              text NOT NULL CHECK (type IN ('estate','cooperative')),
  website_url       text,
  robots_ok         boolean,
  robots_checked_on date,
  source_id         text REFERENCES sources(id),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Grape variety normalization: 'Syrah N' and 'shiraz' both point to 'syrah'.
-- ~20 rows that prevent filters from silently missing.
CREATE TABLE grapes (
  code     text PRIMARY KEY,
  label    text NOT NULL,
  synonyms text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE wines (
  id                     text PRIMARY KEY,
  producer_id            text NOT NULL REFERENCES producers(id),
  appellation_id         text NOT NULL,
  color                  text NOT NULL,
  name                   text NOT NULL,
  vintage                smallint CHECK (vintage BETWEEN 1900 AND 2100),
  abv                    numeric(3,1) CHECK (abv BETWEEN 0 AND 20),
  aging                  text,
  -- Retail price in euros, VAT included.
  price_eur              numeric(7,2) CHECK (price_eur >= 0),
  price_as_of            date,
  organic                boolean,
  certification          text,
  tasting_note           text,
  tasting_note_source_id text REFERENCES sources(id),
  producer_pairings      text[] NOT NULL DEFAULT '{}',
  embedding_text         text,
  embedding              vector(1536),
  embedding_level        text NOT NULL DEFAULT 'appellation'
                           CHECK (embedding_level IN ('wine','appellation')),
  available              boolean NOT NULL DEFAULT true,
  page_url               text,
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- A wine can only exist in a color permitted by its appellation. A white
  -- Pic Saint-Loup is structurally impossible, without any trigger, through
  -- plain referential integrity.
  FOREIGN KEY (appellation_id, color)
    REFERENCES appellation_colors(appellation_id, color),

  -- "No invention", enforced below the LLM layer:
  -- no tasting note without a citable source.
  CONSTRAINT note_requires_source
    CHECK (tasting_note IS NULL OR tasting_note_source_id IS NOT NULL),

  -- A price without the date it was observed is an unverifiable price.
  CONSTRAINT price_requires_date
    CHECK (price_eur IS NULL OR price_as_of IS NOT NULL),

  -- "Level separation": the declared level and the presence of the note
  -- cannot diverge, in either direction.
  CONSTRAINT level_consistent
    CHECK ((embedding_level = 'wine') = (tasting_note IS NOT NULL)),

  UNIQUE (producer_id, name, vintage)
);

CREATE TABLE wine_grapes (
  wine_id text NOT NULL REFERENCES wines(id) ON DELETE CASCADE,
  grape   text NOT NULL REFERENCES grapes(code),
  pct     numeric(5,2) CHECK (pct > 0 AND pct <= 100),
  PRIMARY KEY (wine_id, grape)
);

CREATE INDEX wines_filters_idx       ON wines (appellation_id, color, vintage);
CREATE INDEX wines_price_idx         ON wines (price_eur) WHERE price_eur IS NOT NULL;
CREATE INDEX wines_organic_idx       ON wines (organic) WHERE organic;
CREATE INDEX wines_available_idx     ON wines (available) WHERE available;
CREATE INDEX wines_producer_idx      ON wines (producer_id);
CREATE INDEX wines_note_source_idx   ON wines (tasting_note_source_id);
CREATE INDEX wine_grapes_grape_idx   ON wine_grapes (grape);
CREATE INDEX wines_name_trgm_idx     ON wines     USING gin (name gin_trgm_ops);
CREATE INDEX producers_name_trgm_idx ON producers USING gin (name gin_trgm_ops);
