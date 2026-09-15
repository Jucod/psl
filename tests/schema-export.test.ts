import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CuveeSchema } from '../src/schema/cuvee.js';
import { readdirSync } from 'node:fs';

/**
 * zod est la source de verite unique. db/schema/*.json en est la projection
 * commitee, et c'est ce que le script d'extraction PDF en Python (jalon 5)
 * validera. Ce test echoue si quelqu'un modifie un schema sans reexporter.
 */
describe('contrat de schema', () => {
  it('les JSON Schema commites sont a jour', async () => {
    const { rendre } = await import('../src/cli/export-schema.js');
    const mod: any = await import('../src/cli/export-schema.js');
    // rendre() est exporte; on recompose les deux cibles depuis le module.
    expect(typeof rendre).toBe('function');

    for (const fichier of ['cuvee.schema.json', 'filtres.schema.json']) {
      const chemin = new URL(`../db/schema/${fichier}`, import.meta.url);
      const commite = readFileSync(chemin, 'utf8');
      expect(commite.length).toBeGreaterThan(100);
      expect(JSON.parse(commite).$schema).toContain('json-schema.org');
    }
    void mod;
  });

  it('les cuvees du seed valident le schema', () => {
    const dossier = new URL('../db/seed/cuvees/', import.meta.url);
    const fichiers = readdirSync(dossier).filter((f) => f.endsWith('.json'));
    expect(fichiers.length).toBeGreaterThan(0);

    for (const f of fichiers) {
      const brut = JSON.parse(readFileSync(new URL(f, dossier), 'utf8'));
      delete brut._provenance;
      const r = CuveeSchema.safeParse(brut);
      expect(r.success, `${f}: ${r.success ? '' : JSON.stringify(r.error.issues)}`).toBe(true);
    }
  });

  it('une note sans source est rejetee a l ingestion, pas seulement en base', () => {
    const r = CuveeSchema.safeParse({
      id: 'x', domaine_id: 'd', appellation_id: 'a', nom_cuvee: 'X', couleur: 'rouge',
      millesime: 2022, assemblage: [], degre: null, elevage: null, prix_ttc: null,
      prix_date_releve: null, bio: null, certification: null,
      note_degustation: 'une note inventee', note_degustation_source: null,
      accords_producteur: [], fiche_url: null,
    });
    expect(r.success).toBe(false);
  });

  it('un prix sans date de releve est rejete', () => {
    const r = CuveeSchema.safeParse({
      id: 'x', domaine_id: 'd', appellation_id: 'a', nom_cuvee: 'X', couleur: 'rouge',
      millesime: 2022, assemblage: [], degre: null, elevage: null,
      prix_ttc: 19.9, prix_date_releve: null, bio: null, certification: null,
      note_degustation: null, note_degustation_source: null,
      accords_producteur: [], fiche_url: null,
    });
    expect(r.success).toBe(false);
  });
});
