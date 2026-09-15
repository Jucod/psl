-- Journal des recherches. Sert trois usages a la fois: rate limiting par IP,
-- plafond de depense journalier, et preuve de demo (ce que le systeme a
-- compris, ce qu'il a relache, ce qu'il a refuse).
-- Couple le rate limiter a la disponibilite de la base; acceptable pour une
-- demo, evite un Redis. A revoir si le trafic monte.
CREATE TABLE recherches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_hash               text,
  message               text,
  message_len           int NOT NULL,
  filtres               jsonb,
  contraintes_relachees text[] NOT NULL DEFAULT '{}',
  statut                text NOT NULL CHECK (statut IN (
                          'ok',
                          'refus_hors_catalogue',
                          'vide',
                          'degrade',
                          'schema_invalide',
                          'rate_limited',
                          'cap_budget',
                          'message_trop_long'
                        )),
  cuvees_retournees     text[] NOT NULL DEFAULT '{}',
  provider_llm          text,
  tokens_in             int,
  tokens_out            int,
  cout_eur              numeric(10,6) NOT NULL DEFAULT 0,
  latence_ms            int,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recherches_jour_idx ON recherches (created_at DESC);
CREATE INDEX recherches_ip_idx   ON recherches (ip_hash, created_at DESC);
