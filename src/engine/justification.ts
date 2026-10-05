import type { EmbeddingProvider } from '../embeddings/index.js';

/**
 * Picks, in the producer's note, the sentence that ACTUALLY motivates the
 * ranking.
 *
 * Without this, the justification quoted the first 110 characters of the
 * note, i.e. the color and the nose, while the request was about texture. The
 * system looked like it was justifying without ever answering the question.
 *
 * No rewriting: an existing sentence is selected, it is not reworded. This is
 * selection, not generation.
 */
export async function pickExcerpt(
  note: string,
  queryVector: readonly number[] | null,
  provider: EmbeddingProvider,
): Promise<string | null> {
  if (!queryVector) return null;

  const sentences = splitSentences(note);
  if (sentences.length <= 1) return null;

  const vectors = await provider.embed(sentences);
  let best = -Infinity;
  let winner: string | null = null;

  for (const [i, sentence] of sentences.entries()) {
    const v = vectors[i];
    if (!v) continue;
    let score = 0;
    for (let d = 0; d < queryVector.length; d++) score += (queryVector[d] ?? 0) * (v[d] ?? 0);
    if (score > best) {
      best = score;
      winner = sentence;
    }
  }

  // A sentence that matches nothing is not a justification.
  return best > 0.05 ? winner : null;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15);
}
