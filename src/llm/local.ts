import { readFile } from 'node:fs/promises';
import { construireIndexCepages } from '../ingest/util.js';
import type { Filtres } from '../schema/filtres.js';
import type { Resultat } from '../moteur/types.js';
import { parser } from './parseur.js';
import { USAGE_NUL, type EntreeFormulation, type FournisseurLlm, type ResultatExtraction } from './index.js';

const CHEMIN_CEPAGES = new URL('../../db/seed/cepages.json', import.meta.url).pathname;

/**
 * Provider sans reseau ni cle API.
 *
 * Appel 1 : parseur deterministe (src/llm/parseur.ts).
 * Appel 2 : gabarit qui ne fait que concatener des champs venus de la base.
 *
 * Ce n'est pas qu'un bouche-trou. Il demontre que les garanties du contrat de
 * comportement (§3 du brief) tiennent SANS modele: pas d'invention possible
 * puisqu'aucun texte n'est genere, refus et elargissements produits par des
 * requetes, tracabilite integrale. Le LLM, ensuite, n'ameliore que la
 * formulation. C'est l'argument a montrer a un prospect: le moteur ne depend
 * pas de la bonne volonte du modele.
 */
export class LlmLocal implements FournisseurLlm {
  readonly nom = 'local';
  private index: ReadonlyMap<string, string> | null = null;

  private async indexCepages(): Promise<ReadonlyMap<string, string>> {
    if (!this.index) {
      const doc = JSON.parse(await readFile(CHEMIN_CEPAGES, 'utf8'));
      this.index = construireIndexCepages(doc.cepages);
    }
    return this.index;
  }

  async extraireFiltres(
    message: string,
    appellationParDefaut: string | null,
  ): Promise<ResultatExtraction> {
    const filtres = parser(message, {
      appellationParDefaut,
      indexCepages: await this.indexCepages(),
    });
    return { filtres, degrade: false, raisonDegrade: null, usage: USAGE_NUL };
  }

  async formuler(entree: EntreeFormulation): Promise<{ texte: string; usage: typeof USAGE_NUL }> {
    return { texte: formulerParGabarit(entree), usage: USAGE_NUL };
  }
}

const EUROS = (n: number) => `${n.toFixed(2).replace(/\.00$/, '')} €`;

/**
 * Formulation par gabarit. Aucune phrase n'est produite a partir d'autre chose
 * que des valeurs lues en base. Loi Evin: uniquement des references objectives
 * (cepage, elevage, degre, prix, descripteurs recopies de la fiche). Aucun
 * registre evocateur possible, il n'y a pas de generation.
 */
export function formulerParGabarit(entree: EntreeFormulation): string {
  const r = entree.recherche;
  const lignes: string[] = [];

  if (r.statut === 'refus_hors_catalogue' && r.refus) {
    lignes.push(r.refus.message);
    if (r.refus.source) {
      lignes.push(`Source : ${r.refus.source.label} (${r.refus.source.url}).`);
    }
    return lignes.join('\n');
  }

  if (r.relachements.length > 0) {
    lignes.push(
      `Aucun resultat avec vos criteres initiaux. J'ai elargi : ` +
      r.relachements.map((x) => x.annonce).join(', ') + '.',
    );
  }

  if (r.statut === 'vide') {
    lignes.push(
      r.tailleCatalogue === 0
        ? `Le catalogue ne contient aucune cuvee correspondant a cette appellation et cette couleur.`
        : `Aucune des ${r.tailleCatalogue} cuvee(s) du catalogue ne satisfait ces criteres, ` +
          `meme apres elargissement.`,
    );
    return lignes.join('\n');
  }

  lignes.push(
    r.resultats.length === 1
      ? 'Une reference correspond :'
      : `${r.resultats.length} references correspondent :`,
  );

  for (const [i, c] of r.resultats.entries()) {
    lignes.push('');
    lignes.push(`${i + 1}. ${c.domaine} — ${c.nom_cuvee}${c.millesime ? ` ${c.millesime}` : ''}`);
    lignes.push(`   ${decrireFaits(c)}`);

    if (c.note_degustation && c.note_source) {
      lignes.push(`   Note du producteur : « ${extrait(c.note_degustation)} »`);
      lignes.push(`   Source : ${c.note_source.label}, relevee le ${c.note_source.date_releve} — ${c.note_source.url}`);
      if (c.fixture) {
        lignes.push(`   ATTENTION : donnee de developpement, non relevee sur une fiche technique.`);
      }
    } else if (c.profil_appellation) {
      // Separation des niveaux: on annonce que ce qui suit decrit
      // l'appellation, pas la cuvee.
      lignes.push(
        `   Aucune fiche technique indexee pour cette cuvee. ` +
        `Profil de l'appellation : ${c.profil_appellation.texte}`,
      );
      lignes.push(
        `   Source : ${c.profil_appellation.source.label}` +
        (c.profil_appellation.section ? ` (${c.profil_appellation.section})` : '') +
        ` — ${c.profil_appellation.source.url}`,
      );
    }
  }

  if (r.accordsPourLePlat.length > 0) {
    lignes.push('');
    lignes.push(
      `Accords suggeres pour ce type de plat, deduits du profil d'appellation ` +
      `(et non d'une caracteristique de ces cuvees) : ` +
      r.accordsPourLePlat.map((a) => a.libelle).join(', ') + '.',
    );
  }

  return lignes.join('\n');
}

function decrireFaits(c: Resultat): string {
  const faits: string[] = [];
  if (c.assemblage.length > 0) {
    faits.push(
      c.assemblage
        .map((a) => (a.pct === null ? a.cepage : `${a.cepage} ${a.pct}%`))
        .join(', '),
    );
  }
  if (c.degre !== null) faits.push(`${c.degre}%`);
  if (c.elevage) faits.push(`elevage : ${c.elevage}`);
  if (c.certification) faits.push(c.certification);
  if (c.prix_ttc !== null) {
    faits.push(
      `${EUROS(c.prix_ttc)}${c.prix_date_releve ? ` (prix releve le ${c.prix_date_releve})` : ''}`,
    );
  }
  return faits.length ? faits.join(' · ') : 'aucune caracteristique technique indexee';
}

/**
 * "On cite, on ne republie pas." Les fiches techniques sont publiques mais
 * restent la propriete du domaine: on en donne un extrait et le lien, pas le
 * texte integral.
 */
export function extrait(texte: string, max = 200): string {
  if (texte.length <= max) return texte;
  const coupe = texte.slice(0, max);
  const dernier = Math.max(coupe.lastIndexOf('. '), coupe.lastIndexOf(', '));
  return (dernier > max * 0.5 ? coupe.slice(0, dernier) : coupe).trimEnd() + '…';
}
