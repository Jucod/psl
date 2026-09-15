-- Tracabilite. Tout element descriptif affiche pointe vers une ligne d'ici.
-- L'URL et la date de releve vivent ICI et nulle part ailleurs: pas de
-- duplication, pas de derive entre deux copies de la meme URL.
CREATE TABLE sources (
  id             text PRIMARY KEY,
  type           text NOT NULL CHECK (type IN (
                   'cahier_des_charges',
                   'fiche_technique',
                   'annuaire',
                   'page_domaine',
                   -- Donnee de developpement, jamais publiable. Le moteur
                   -- refuse de servir une cuvee adossee a ce type sauf flag
                   -- explicite. Voir src/moteur/recherche.ts.
                   'fixture_dev'
                 )),
  label          text NOT NULL,
  url            text NOT NULL,
  autorite       text,
  date_releve    date NOT NULL,
  contenu_sha256 text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sources_type_idx ON sources (type);
