import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { designationLabel } from '../config/domain.js';
import { buildGrapeIndex } from '../ingest/util.js';
import { parseMessage } from './parser.js';
import {
  ZERO_USAGE, type ExtractionContext, type ExtractionResult, type FormulationInput, type LlmProvider,
} from './index.js';

const GRAPES_PATH = fileURLToPath(new URL('../../db/seed/grapes.json', import.meta.url));

/**
 * Provider with no network and no API key.
 *
 * Call 1: deterministic parser (src/llm/parser.ts).
 * Call 2: a template that only concatenates fields coming from the database.
 *
 * It is not just a stopgap. It demonstrates that the guarantees of the
 * behavior contract (§3 of the brief) hold WITHOUT a model: no invention is
 * possible since no text is generated, refusals and relaxations are produced
 * by queries, traceability is complete. The LLM, afterwards, only improves the
 * wording. That is the argument to show a prospect: the engine does not
 * depend on the model's goodwill.
 */
export class LocalLlm implements LlmProvider {
  readonly name = 'local';
  private index: ReadonlyMap<string, string> | null = null;

  private async grapeIndex(): Promise<ReadonlyMap<string, string>> {
    if (!this.index) {
      const doc = JSON.parse(await readFile(GRAPES_PATH, 'utf8'));
      this.index = buildGrapeIndex(doc.grapes);
    }
    return this.index;
  }

  async extractFilters(
    message: string,
    { defaultAppellation, designations }: ExtractionContext,
  ): Promise<ExtractionResult> {
    const filters = parseMessage(message, {
      defaultAppellation,
      designations,
      grapeIndex: await this.grapeIndex(),
    });
    return { filters, degraded: false, degradedReason: null, usage: ZERO_USAGE };
  }

  async formulate(input: FormulationInput): Promise<{ text: string; usage: typeof ZERO_USAGE }> {
    return { text: formulateFromTemplate(input), usage: ZERO_USAGE };
  }
}

const EUROS = (n: number) => `${n.toFixed(2).replace(/\.00$/, '')} €`;

/**
 * Template-based formulation. No sentence is produced from anything other
 * than values read from the database. Loi Evin: objective references only
 * (grape variety, aging, alcohol content, price, descriptors copied from the
 * sheet). No evocative register is possible, there is no generation.
 *
 * The text is addressed to visitors, hence in French.
 */
export function formulateFromTemplate(input: FormulationInput): string {
  const s = input.search;
  const lines: string[] = [];

  if (s.status === 'refused' && s.refusal) {
    lines.push(s.refusal.message);
    if (s.refusal.source) {
      lines.push(`Source : ${s.refusal.source.label} (${s.refusal.source.url}).`);
    }
    return lines.join('\n');
  }

  if (s.relaxations.length > 0) {
    // A nuance that matters: "j'ai elargi" (I widened) announces a result
    // obtained thanks to the relaxation. When it yielded nothing, putting it
    // that way suggests we found something.
    const undecidable = new Set(s.undecidableFilters.map((f) => f.field));
    const useful = s.relaxations.filter((x) => !undecidable.has(x.field));
    // Announcing "I widened the budget" when no price is known is theater:
    // the relaxation had no chance of changing anything, and saying so gives
    // the illusion of an effort that did not take place.
    if (useful.length > 0) {
      lines.push(
        s.status === 'empty'
          ? `Aucun resultat avec vos criteres initiaux. J'ai essaye d'elargir (` +
            useful.map((x) => x.announcement).join(', ') + '), sans resultat.'
          : `Aucun resultat avec vos criteres initiaux. J'ai elargi : ` +
            useful.map((x) => x.announcement).join(', ') + '.',
      );
    }
  }

  if (s.status === 'empty') {
    if (s.undecidableFilters.length > 0) {
      // A decisive nuance: the catalog does not CONTRADICT the criterion, it
      // does not know it. Announcing it as an absence would be an unfounded
      // statement, exactly what the system exists to avoid.
      const names = s.undecidableFilters.map((f) => f.label.toLowerCase()).join(', ');
      lines.push(
        `Je ne peux pas repondre sur ce critere : aucune des ${s.catalogSize} ` +
        `cuvee(s) du catalogue ne porte l'information demandee (${names}). ` +
        `Ce n'est pas une absence de correspondance, c'est une donnee manquante.`,
      );
    } else {
      lines.push(
        s.catalogSize === 0
          ? `Le catalogue ne contient aucune cuvee correspondant a cette designation et cette couleur.`
          : `Aucune des ${s.catalogSize} cuvee(s) du catalogue ne satisfait ces criteres.`,
      );
    }
    return lines.join('\n');
  }

  lines.push(
    s.results.length === 1
      ? 'Une reference correspond :'
      : `${s.results.length} references correspondent :`,
  );

  for (const [i, w] of s.results.entries()) {
    const identity =
      `${i + 1}. ${w.producer}, ${w.name}${w.vintage ? ` ${w.vintage}` : ''}` +
      ` (${designationLabel(w.appellation_name, w.appellation_tier)})` +
      (w.price_eur !== null ? ` — ${EUROS(w.price_eur)}` : '');

    if (w.tasting_note) {
      // Justification quoted from the sheet, not reworded. We prefer the
      // sentence that motivates the ranking to the beginning of the note,
      // which talks about the color.
      const quote = w.relevant_excerpt ?? w.tasting_note;
      lines.push(`${identity}. ${excerpt(quote, 130)}`);
      // Traceability does NOT depend on the rendering channel. The interface
      // shows the source in the card, but this text also goes to the CLI, to
      // the log and into any copy-paste: a descriptive element without its
      // source is a breach of the contract, not an avoided redundancy.
      if (w.note_source) {
        lines.push(
          `   Source : ${w.note_source.label} — ${w.note_source.url}` +
          (w.fixture ? '  [DONNEE DE DEVELOPPEMENT, non relevee sur une fiche]' : ''),
        );
      }
    } else if (w.appellation_profile) {
      // Level separation: says explicitly that we are describing the appellation.
      lines.push(
        `${identity}. Aucune fiche technique indexee pour cette cuvee ; ` +
        `le profil ci-contre est celui de l'appellation.`,
      );
      lines.push(`   Source du profil : ${w.appellation_profile.source.label} — ${w.appellation_profile.source.url}`);
    } else {
      lines.push(`${identity}. Aucun element descriptif indexe.`);
    }
  }

  // Pairings, sources and fixture warnings are rendered by the interface, each
  // in its own place. Repeating them here doubled the length of the page
  // without adding anything.
  return lines.join('\n');
}

/**
 * "We quote, we do not republish." Technical sheets are public but remain the
 * estate's property: we give an excerpt and the link, not the full text.
 */
export function excerpt(text: string, max = 200): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '));
  return (last > max * 0.5 ? cut.slice(0, last) : cut).trimEnd() + '…';
}
