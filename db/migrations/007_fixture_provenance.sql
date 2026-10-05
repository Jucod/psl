-- The fixtures overlay does not only fill in the note: it also sets price,
-- blend, alcohol content, aging and certification. Tracking provenance through
-- the note's source alone let through any row whose note is real but whose
-- other fields are not, which is exactly the intermediate state of a migration
-- towards real producer sheets.
ALTER TABLE wines
  ADD COLUMN from_fixture boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN wines.from_fixture IS
  'At least one field of this row comes from the development overlay. The service masks those fields when PSL_ALLOW_FIXTURES=0.';

CREATE INDEX wines_from_fixture_idx ON wines (from_fixture) WHERE from_fixture;
