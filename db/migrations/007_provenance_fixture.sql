-- Le calque de fixtures ne remplit pas que la note: il pose aussi prix,
-- assemblage, degre, elevage et certification. Suivre la provenance par la
-- seule source de la note laissait passer toute ligne dont la note est reelle
-- mais les autres champs non, ce qui est exactement l'etat intermediaire d'une
-- migration vers de vraies fiches.
ALTER TABLE cuvees
  ADD COLUMN provenance_fixture boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN cuvees.provenance_fixture IS
  'Au moins un champ de cette ligne vient du calque de developpement. Le service masque ces champs quand PSL_AUTORISER_FIXTURES=0.';

CREATE INDEX cuvees_provenance_idx ON cuvees (provenance_fixture) WHERE provenance_fixture;
