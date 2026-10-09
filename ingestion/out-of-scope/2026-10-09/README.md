# Out of scope: wines collected on 2026-10-09

These wines come from Pic Saint-Loup estates, but are not Pic Saint-Loup:
10 × vin-de-france white, 6 × vin-de-france red, 3 × aoc-languedoc white, 2 × igp-saint-guilhem-le-desert red, 1 × aoc-gres-de-montpellier red. They were committed to `db/seed/wines/` by mistake and broke
`npm run setup`: the database refuses a wine whose appellation and color are
not in `appellation_colors`, which only holds Pic Saint-Loup red and rosé.

They are kept here, unchanged, for the day the catalog extends beyond the
appellation. That is a product decision with a cost: each appellation needs
its reference data (INAO specification, permitted colors, grape rules,
sensory profile) in `db/seed/pic-saint-loup-seed.json`, cited like the Pic
Saint-Loup one, and "Vin de France" is not an appellation at all, so it has
neither a specification nor a profile to fall back on.

| id | appellation | color |
|---|---|---|
| coste-ubesse-l-aglandier | igp-saint-guilhem-le-desert | red |
| coste-ubesse-l-auriera-2021 | vin-de-france | white |
| coste-ubesse-moun-poulit-2019 | vin-de-france | red |
| coste-ubesse-piboulo-2022 | aoc-gres-de-montpellier | red |
| coste-ubesse-plan-bastit | igp-saint-guilhem-le-desert | red |
| la-chouette-du-chai-l-orfraie-2024 | aoc-languedoc | white |
| mas-bruguiere-les-muriers-2025 | aoc-languedoc | white |
| mas-foulaquier-chouette-blanche-2023 | vin-de-france | white |
| mas-foulaquier-chouette-blanche-2024 | vin-de-france | white |
| mas-foulaquier-into-the-red-2025 | vin-de-france | red |
| mas-foulaquier-into-the-red-rouge-leger-2024 | vin-de-france | red |
| mas-foulaquier-into-the-white-blanc-2025 | vin-de-france | white |
| mas-foulaquier-l-oiseau-blanc-2025 | vin-de-france | white |
| mas-foulaquier-les-amours-vendangeurs-blanc-2022 | vin-de-france | white |
| mas-foulaquier-les-tonillieres-2020 | vin-de-france | red |
| mas-foulaquier-orange-a-la-mer-2024 | vin-de-france | white |
| mas-foulaquier-orenji-muscat-de-maceration-2025 | vin-de-france | white |
| mas-foulaquier-violetta-rouge-2024 | vin-de-france | red |
| morties-blanc-2025 | aoc-languedoc | white |
| morties-encore-et-encore-rouge-2023 | vin-de-france | red |
| morties-jamais-content-blanc-2024 | vin-de-france | white |
| morties-un-peu-d-agrume-blanc-maceration-2024 | vin-de-france | white |
