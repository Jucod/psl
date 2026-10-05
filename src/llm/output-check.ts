import { FAMILY_BY_STEM, normalize, tokenize } from '../config/lexicon.js';
import type { WineResult } from '../engine/types.js';

/**
 * Check on the model's output.
 *
 * The project already applies this rule at ingestion (milestone 5): any note
 * extracted from a PDF must be found literally in its text layer. Applying it
 * to the output as well gives the system ONE single rule, held at both ends:
 * nothing descriptive exists that is not a verifiable quote.
 *
 * It is also what makes the promise demonstrable live in front of a prospect,
 * where a vocabulary filter can only hope.
 *
 * Two complementary checks:
 *  1. quotes - any segment between quotation marks must be a literal
 *     substring of a passage provided. Exact, zero false positives, and it
 *     catches invention as well as rewording.
 *  2. descriptors - outside quotation marks, the text must not introduce a
 *     sensory family absent from what was provided FOR THAT REFERENCE.
 *     The check is scoped per reference: globally, three notes covering the
 *     lexicon saturated the allowed set and the check became mathematically
 *     unable to reject anything.
 */

export interface Anomaly {
  type: 'non_literal_quote' | 'unsupported_descriptor';
  detail: string;
}

/** Segments between French or straight quotation marks. */
const QUOTE = /[«"]\s*([^»"]{12,600}?)\s*[»"]/g;

function flatten(t: string): string {
  return normalize(t).replace(/\s+/g, ' ').trim();
}

export function checkOutput(text: string, results: readonly WineResult[]): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // --- 1. every quote must be literal ----------------------------------------
  const passages = results.flatMap((w) =>
    [w.tasting_note, w.relevant_excerpt, w.appellation_profile?.text]
      .filter((x): x is string => Boolean(x))
      .map(flatten),
  );

  for (const m of text.matchAll(QUOTE)) {
    const quote = flatten(m[1]!);
    if (!passages.some((p) => p.includes(quote))) {
      anomalies.push({
        type: 'non_literal_quote',
        detail: m[1]!.slice(0, 80),
      });
    }
  }

  // --- 2. descriptors, scoped per reference ----------------------------------
  for (const { reference, segment } of segmentByReference(text, results)) {
    const allowed = familiesIn(
      [
        reference?.tasting_note,
        reference?.relevant_excerpt,
        reference?.appellation_profile?.text,
        reference?.aging,
        reference?.certification,
        ...(reference?.blend ?? []).map((b) => b.grape),
      ]
        .filter((x): x is string => Boolean(x))
        .join(' '),
    );

    for (const family of familiesIn(withoutQuotes(segment))) {
      if (!allowed.has(family)) {
        anomalies.push({
          type: 'unsupported_descriptor',
          detail: `${reference?.id ?? 'introduction'} : ${family}`,
        });
      }
    }
  }

  return anomalies;
}

function familiesIn(text: string): Set<string> {
  const families = new Set<string>();
  for (const t of tokenize(text)) {
    const f = FAMILY_BY_STEM.get(t);
    if (f) families.add(f);
  }
  return families;
}

function withoutQuotes(text: string): string {
  return text.replace(QUOTE, ' ');
}

/**
 * Splits the answer per reference, relying on the wine's name and then on the
 * producer's. The segment that precedes the first reference is the
 * introduction: no note is attached to it, so any sensory descriptor in it is
 * an anomaly.
 */
function segmentByReference(
  text: string,
  results: readonly WineResult[],
): { reference: WineResult | null; segment: string }[] {
  const flat = normalize(text);

  const anchors = results
    .map((r) => {
      for (const marker of [r.name, r.producer]) {
        const i = flat.indexOf(normalize(marker));
        if (i !== -1) return { reference: r, index: i };
      }
      return null;
    })
    .filter((a): a is { reference: WineResult; index: number } => a !== null)
    .sort((a, b) => a.index - b.index);

  if (anchors.length === 0) return [{ reference: null, segment: text }];

  const blocks: { reference: WineResult | null; segment: string }[] = [];
  if (anchors[0]!.index > 0) {
    blocks.push({ reference: null, segment: text.slice(0, anchors[0]!.index) });
  }
  for (const [i, a] of anchors.entries()) {
    const end = anchors[i + 1]?.index ?? text.length;
    blocks.push({ reference: a.reference, segment: text.slice(a.index, end) });
  }
  return blocks;
}
