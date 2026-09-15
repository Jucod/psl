CREATE TABLE domaines (
  id                text PRIMARY KEY,
  nom               text NOT NULL,
  commune           text,
  departement       text,
  type              text NOT NULL CHECK (type IN ('domaine','cave_cooperative')),
  site_url          text,
  robots_ok         boolean,
  robots_verifie_le date,
  source_id         text REFERENCES sources(id),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Normalisation des cepages: 'Syrah N' et 'shiraz' pointent tous deux sur
-- 'syrah'. ~20 lignes qui evitent des filtres qui ratent en silence.
CREATE TABLE cepages (
  code      text PRIMARY KEY,
  libelle   text NOT NULL,
  synonymes text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE cuvees (
  id                         text PRIMARY KEY,
  domaine_id                 text NOT NULL REFERENCES domaines(id),
  appellation_id             text NOT NULL,
  couleur                    text NOT NULL,
  nom_cuvee                  text NOT NULL,
  millesime                  smallint CHECK (millesime BETWEEN 1900 AND 2100),
  degre                      numeric(3,1) CHECK (degre BETWEEN 0 AND 20),
  elevage                    text,
  prix_ttc                   numeric(7,2) CHECK (prix_ttc >= 0),
  prix_date_releve           date,
  bio                        boolean,
  certification              text,
  note_degustation           text,
  note_degustation_source_id text REFERENCES sources(id),
  accords_producteur         text[] NOT NULL DEFAULT '{}',
  embedding_source           text,
  embedding                  vector(1536),
  embedding_niveau           text NOT NULL DEFAULT 'appellation'
                               CHECK (embedding_niveau IN ('cuvee','appellation')),
  disponible                 boolean NOT NULL DEFAULT true,
  fiche_url                  text,
  updated_at                 timestamptz NOT NULL DEFAULT now(),

  -- Une cuvee ne peut exister que dans une couleur autorisee par son
  -- appellation. Un Pic Saint-Loup blanc est structurellement impossible,
  -- sans trigger, par simple integrite referentielle.
  FOREIGN KEY (appellation_id, couleur)
    REFERENCES appellation_couleurs(appellation_id, couleur),

  -- "Aucune invention", applique sous la couche LLM:
  -- pas de note de degustation sans source citable.
  CONSTRAINT note_exige_source
    CHECK (note_degustation IS NULL OR note_degustation_source_id IS NOT NULL),

  -- Un prix sans date de releve est un prix non verifiable.
  CONSTRAINT prix_exige_date
    CHECK (prix_ttc IS NULL OR prix_date_releve IS NOT NULL),

  -- "Separation des niveaux": le niveau declare et la presence de la note
  -- ne peuvent pas diverger, dans un sens ni dans l'autre.
  CONSTRAINT niveau_coherent
    CHECK ((embedding_niveau = 'cuvee') = (note_degustation IS NOT NULL)),

  UNIQUE (domaine_id, nom_cuvee, millesime)
);

CREATE TABLE cuvee_cepages (
  cuvee_id text NOT NULL REFERENCES cuvees(id) ON DELETE CASCADE,
  cepage   text NOT NULL REFERENCES cepages(code),
  pct      numeric(5,2) CHECK (pct > 0 AND pct <= 100),
  PRIMARY KEY (cuvee_id, cepage)
);

CREATE INDEX cuvees_filtres_idx    ON cuvees (appellation_id, couleur, millesime);
CREATE INDEX cuvees_prix_idx       ON cuvees (prix_ttc) WHERE prix_ttc IS NOT NULL;
CREATE INDEX cuvees_bio_idx        ON cuvees (bio) WHERE bio;
CREATE INDEX cuvees_dispo_idx      ON cuvees (disponible) WHERE disponible;
CREATE INDEX cuvees_domaine_idx    ON cuvees (domaine_id);
CREATE INDEX cuvees_note_src_idx   ON cuvees (note_degustation_source_id);
CREATE INDEX cuvee_cepages_cep_idx ON cuvee_cepages (cepage);
CREATE INDEX cuvees_nom_trgm_idx   ON cuvees   USING gin (nom_cuvee gin_trgm_ops);
CREATE INDEX domaines_nom_trgm_idx ON domaines USING gin (nom gin_trgm_ops);
