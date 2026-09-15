import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { slug } from './util.js';

const CHEMIN_SEED = new URL('../../db/seed/pic-saint-loup-seed.json', import.meta.url).pathname;
const CHEMIN_CEPAGES = new URL('../../db/seed/cepages.json', import.meta.url).pathname;

/** Date du releve manuel du referentiel, pas de la publication du texte INAO. */
const DATE_RELEVE = '2026-09-14';

export interface ResultatReferentiel {
  sources: number; appellations: number; couleurs: number;
  profils: number; accords: number; domaines: number; cepages: number;
}

export async function ingererReferentiel(client: pg.PoolClient): Promise<ResultatReferentiel> {
  const seed = JSON.parse(await readFile(CHEMIN_SEED, 'utf8'));
  const cepagesDoc = JSON.parse(await readFile(CHEMIN_CEPAGES, 'utf8'));

  const res: ResultatReferentiel = {
    sources: 0, appellations: 0, couleurs: 0, profils: 0, accords: 0, domaines: 0, cepages: 0,
  };

  const typeSource = (id: string): string => {
    if (id === 'inao_cdc_psl') return 'cahier_des_charges';
    if (id === 'syndicat_psl' || id === 'ot_grand_psl') return 'annuaire';
    return 'page_domaine';
  };

  for (const s of seed._meta.sources) {
    await client.query(
      `INSERT INTO sources (id, type, label, url, autorite, date_releve)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         type=EXCLUDED.type, label=EXCLUDED.label, url=EXCLUDED.url,
         autorite=EXCLUDED.autorite, date_releve=EXCLUDED.date_releve`,
      [slug(s.id), typeSource(s.id), s.label, s.url, s.autorite ?? null, DATE_RELEVE],
    );
    res.sources++;
  }

  for (const a of seed.appellations) {
    await client.query(
      `INSERT INTO appellations
         (id, nom, statut, region, reconnaissance_annee, communes, encepagement,
          production, terroir, source_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         nom=EXCLUDED.nom, statut=EXCLUDED.statut, region=EXCLUDED.region,
         reconnaissance_annee=EXCLUDED.reconnaissance_annee,
         communes=EXCLUDED.communes, encepagement=EXCLUDED.encepagement,
         production=EXCLUDED.production, terroir=EXCLUDED.terroir,
         source_id=EXCLUDED.source_id, updated_at=now()`,
      [
        a.id, a.nom, a.statut, a.region,
        a.reconnaissance_aoc ? Number(a.reconnaissance_aoc) : null,
        JSON.stringify(a.communes ?? {}),
        JSON.stringify(a.encepagement ?? {}),
        JSON.stringify(a.production ?? {}),
        JSON.stringify(a.terroir ?? {}),
        slug(a.source),
      ],
    );
    res.appellations++;

    // Table qui produit le refus "l'AOC ne couvre que les rouges et roses".
    for (const couleur of a.couleurs_autorisees) {
      await client.query(
        `INSERT INTO appellation_couleurs (appellation_id, couleur)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [a.id, couleur],
      );
      res.couleurs++;
    }

    const profils = a.profil_organoleptique_officiel ?? {};
    const sectionSource: string | undefined = profils._source;
    for (const [couleur, p] of Object.entries<any>(profils)) {
      if (couleur.startsWith('_')) continue;
      if (!a.couleurs_autorisees.includes(couleur)) continue;

      // Texte plat embedde au niveau APPELLATION. Jamais fusionne avec une
      // note de cuvee: fusionner rendrait toutes les cuvees de l'AOC
      // colineaires et ecraserait le classement.
      const texte = [
        p.robe ? `robe ${p.robe}` : null,
        Array.isArray(p.aromes) && p.aromes.length ? `aromes ${p.aromes.join(', ')}` : null,
        p.bouche ? `bouche ${p.bouche}` : null,
        p.structure ?? null,
        p.garde ?? null,
      ].filter(Boolean).join('. ');

      await client.query(
        `INSERT INTO appellation_profils
           (appellation_id, couleur, robe, aromes, bouche, structure, garde,
            texte_profil, source_id, source_section)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (appellation_id, couleur) DO UPDATE SET
           robe=EXCLUDED.robe, aromes=EXCLUDED.aromes, bouche=EXCLUDED.bouche,
           structure=EXCLUDED.structure, garde=EXCLUDED.garde,
           texte_profil=EXCLUDED.texte_profil, source_id=EXCLUDED.source_id,
           source_section=EXCLUDED.source_section`,
        [a.id, couleur, p.robe ?? null, p.aromes ?? [], p.bouche ?? null,
         p.structure ?? null, p.garde ?? null, texte, slug('inao_cdc_psl'),
         sectionSource ?? null],
      );
      res.profils++;
    }

    // Accords DERIVES. Le champ `ancrage` du seed n'est PAS repris: prose
    // editoriale non sourcee, au registre evocateur que la loi Evin proscrit.
    const accords = a.accords_mets ?? {};
    const CATEGORIES: Record<string, 'viande' | 'fromage' | 'poisson'> = {
      viandes: 'viande', fromages: 'fromage', poissons: 'poisson',
    };
    for (const [couleur, bloc] of Object.entries<any>(accords)) {
      if (couleur.startsWith('_')) continue;
      if (!a.couleurs_autorisees.includes(couleur)) continue;
      for (const [cle, categorie] of Object.entries(CATEGORIES)) {
        for (const libelle of bloc[cle] ?? []) {
          await client.query(
            `INSERT INTO appellation_accords
               (appellation_id, couleur, categorie, libelle, statut, derive_de)
             VALUES ($1,$2,$3,$4,'derive',$5)
             ON CONFLICT (appellation_id, couleur, categorie, libelle) DO NOTHING`,
            [a.id, couleur, categorie, libelle, `profil_organoleptique_officiel.${couleur}`],
          );
          res.accords++;
        }
      }
    }
  }

  const prod = seed.producteurs ?? {};
  for (const d of prod.domaines ?? []) {
    await client.query(
      `INSERT INTO domaines (id, nom, commune, departement, type, site_url, source_id)
       VALUES ($1,$2,$3,$4,'domaine',$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         nom=EXCLUDED.nom, commune=EXCLUDED.commune, type=EXCLUDED.type,
         source_id=EXCLUDED.source_id, updated_at=now()`,
      [slug(d.nom), d.nom, d.commune ?? null, 'Herault',
       d.site === 'TODO' ? null : d.site, slug('syndicat_psl')],
    );
    res.domaines++;
  }
  for (const c of prod.caves_cooperatives ?? []) {
    await client.query(
      `INSERT INTO domaines (id, nom, commune, departement, type, source_id)
       VALUES ($1,$2,$3,$4,'cave_cooperative',$5)
       ON CONFLICT (id) DO UPDATE SET
         nom=EXCLUDED.nom, commune=EXCLUDED.commune, type=EXCLUDED.type, updated_at=now()`,
      [slug(c.nom), c.nom, (c.communes ?? [])[0] ?? null, 'Herault', slug('syndicat_psl')],
    );
    res.domaines++;
  }

  for (const c of cepagesDoc.cepages) {
    await client.query(
      `INSERT INTO cepages (code, libelle, synonymes) VALUES ($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET libelle=EXCLUDED.libelle, synonymes=EXCLUDED.synonymes`,
      [c.code, c.libelle, c.synonymes],
    );
    res.cepages++;
  }

  return res;
}
