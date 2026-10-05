import { normalize } from '../config/lexicon.js';

/**
 * Detection of instructions inside a tasting note, at INGESTION time.
 *
 * The real injection vector of this system is not the user - their request
 * never reaches the formulation prompt - it is the CORPUS. A technical sheet
 * is third-party text, and at milestone 5 it will come from a PDF downloaded
 * from a site we do not control.
 *
 * Why here and not online: ingestion is offline, rare and supervised. A false
 * positive there costs thirty seconds of human review. Online, it would cost
 * a visitor a degraded answer. It is the only heuristic filter this project
 * allows itself, and it sits where being wrong is cheap.
 *
 * The note is not rejected: it is QUARANTINED, i.e. flagged for review. An
 * estate that writes "laissez-vous tenter" ("let yourself be tempted") has
 * done nothing wrong.
 *
 * The patterns target French text, since that is the language of the corpus.
 */

const PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'addressed to a system', pattern: /\b(ignore|ignorez|oublie|oubliez)\b[^.]{0,40}\b(consigne|instruction|regle|precedent)/i },
  { name: 'role assignment', pattern: /\btu es\b|\bvous etes\b[^.]{0,30}\b(assistant|sommelier|modele|ia)\b/i },
  { name: 'prompt vocabulary', pattern: /\b(system prompt|prompt|instruction system|<\|)/i },
  { name: 'answer injunction', pattern: /\b(reponds|repondez|ecris|ecrivez|affiche|affichez)\b[^.]{0,30}\b(que|uniquement|plutot|a la place)\b/i },
  { name: 'technical tag', pattern: /<\/?\s*(system|assistant|user|instruction)\s*>/i },
];

export interface QuarantinedNote {
  wineId: string;
  patterns: string[];
  excerpt: string;
}

export function inspectNote(wineId: string, note: string | null): QuarantinedNote | null {
  if (!note) return null;
  const flat = normalize(note);
  const patterns = PATTERNS.filter((p) => p.pattern.test(flat)).map((p) => p.name);
  if (patterns.length === 0) return null;
  return { wineId, patterns, excerpt: note.slice(0, 120) };
}
