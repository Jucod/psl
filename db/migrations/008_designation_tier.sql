-- The catalog now holds every still wine of the Pic Saint-Loup estates,
-- including the ones they release under a neighbouring designation (a white
-- under AOP Languedoc, a red under IGP Saint-Guilhem-le-Desert or as a Vin de
-- France). `appellations` therefore holds designations of three legal tiers,
-- and the tier is what the interface shows: only an AOP is a protected
-- designation of origin, and a visitor must be able to tell at a glance.
--
--   aop  : appellation d'origine protegee (AOC/AOP), INAO specification
--   igp  : indication geographique protegee, with its own specification
--   vsig : vin sans indication geographique ("Vin de France"), no specification
--
-- The table keeps its name: renaming it, and appellation_id everywhere, would
-- cost a migration of every query for a word.
ALTER TABLE appellations
  ADD COLUMN tier text NOT NULL DEFAULT 'aop' CHECK (tier IN ('aop', 'igp', 'vsig')),
  -- The ways a visitor names the designation in a request ("pic st loup",
  -- "aop languedoc"), read by the deterministic parser and listed to the model.
  ADD COLUMN aliases text[] NOT NULL DEFAULT '{}';

-- The default only backfills the rows loaded before this migration (the Pic
-- Saint-Loup AOC): every new designation must state its tier.
ALTER TABLE appellations ALTER COLUMN tier DROP DEFAULT;

COMMENT ON COLUMN appellations.tier IS
  'aop, igp or vsig. Drives the AOP badge: a protected designation of origin is shown as such, the others are not.';

-- "Vin de France" has no specification: it is defined by regulation, and the
-- source that says so is cited as what it is.
ALTER TABLE sources DROP CONSTRAINT sources_type_check;
ALTER TABLE sources ADD CONSTRAINT sources_type_check CHECK (type IN (
  'specification', 'regulation', 'tech_sheet', 'directory', 'producer_page', 'dev_fixture'
));

-- One cuvee name can cover two colors: Mortiès sells a "Jamais Content" red
-- under the Pic Saint-Loup AOP and a "Jamais Content" white as a Vin de
-- France, same vintage. As long as the AOC held no white, the key without the
-- color could not meet the case.
ALTER TABLE wines DROP CONSTRAINT wines_producer_id_name_vintage_key;
ALTER TABLE wines ADD CONSTRAINT wines_producer_id_name_color_vintage_key
  UNIQUE (producer_id, name, color, vintage);
