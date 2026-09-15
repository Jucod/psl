-- Referentiel d'appellation. Les payloads jamais filtres (communes,
-- encepagement, production, terroir) restent en jsonb: six tables que
-- personne n'interroge ne valent pas leur cout de maintenance.
CREATE TABLE appellations (
  id                   text PRIMARY KEY,
  nom                  text NOT NULL,
  statut               text,
  region               text,
  reconnaissance_annee smallint,
  communes             jsonb NOT NULL DEFAULT '{}'::jsonb,
  encepagement         jsonb NOT NULL DEFAULT '{}'::jsonb,
  production           jsonb NOT NULL DEFAULT '{}'::jsonb,
  terroir              jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_id            text NOT NULL REFERENCES sources(id),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Couleurs REELLEMENT autorisees par le cahier des charges.
-- C'est cette table qui produit le refus "l'AOC Pic Saint-Loup ne couvre
-- que les rouges et roses". Le refus est un resultat de requete, pas une
-- consigne de prompt: il est testable sans appel LLM.
CREATE TABLE appellation_couleurs (
  appellation_id text NOT NULL REFERENCES appellations(id) ON DELETE CASCADE,
  couleur        text NOT NULL CHECK (couleur IN ('rouge','rose','blanc')),
  PRIMARY KEY (appellation_id, couleur)
);

-- Profil organoleptique officiel, par couleur. Source citable (INAO).
-- Sert de repli d'embedding quand une cuvee n'a pas de note producteur.
CREATE TABLE appellation_profils (
  appellation_id text NOT NULL,
  couleur        text NOT NULL,
  robe           text,
  aromes         text[] NOT NULL DEFAULT '{}',
  bouche         text,
  structure      text,
  garde          text,
  texte_profil   text NOT NULL,
  embedding      vector(1536),
  source_id      text NOT NULL REFERENCES sources(id),
  source_section text,
  PRIMARY KEY (appellation_id, couleur),
  FOREIGN KEY (appellation_id, couleur)
    REFERENCES appellation_couleurs(appellation_id, couleur) ON DELETE CASCADE
);

-- Accords mets-vins: DERIVES du profil, jamais une donnee source.
-- Le CHECK interdit structurellement de les promouvoir en fait etabli.
CREATE TABLE appellation_accords (
  id             bigserial PRIMARY KEY,
  appellation_id text NOT NULL,
  couleur        text NOT NULL,
  categorie      text NOT NULL CHECK (categorie IN ('viande','fromage','poisson','autre')),
  libelle        text NOT NULL,
  statut         text NOT NULL DEFAULT 'derive' CHECK (statut = 'derive'),
  derive_de      text NOT NULL,
  UNIQUE (appellation_id, couleur, categorie, libelle),
  FOREIGN KEY (appellation_id, couleur)
    REFERENCES appellation_couleurs(appellation_id, couleur) ON DELETE CASCADE
);

CREATE INDEX appellation_accords_lookup_idx
  ON appellation_accords (appellation_id, couleur, categorie);
