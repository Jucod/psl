-- Traceability. Every descriptive element shown to a visitor points to a row
-- in this table. The URL and the retrieval date live HERE and nowhere else:
-- no duplication, no drift between two copies of the same URL.
CREATE TABLE sources (
  id             text PRIMARY KEY,
  type           text NOT NULL CHECK (type IN (
                   'specification',  -- the appellation's official specification (INAO)
                   'tech_sheet',
                   'directory',
                   'producer_page',
                   -- Development data, never publishable. The engine masks the
                   -- fields backed by this type unless explicitly allowed.
                   -- See src/engine/search.ts.
                   'dev_fixture'
                 )),
  label          text NOT NULL,
  url            text NOT NULL,
  authority      text,
  retrieved_on   date NOT NULL,
  content_sha256 text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sources_type_idx ON sources (type);
