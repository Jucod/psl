import type { FournisseurEmbedding } from '../embeddings/index.js';

/**
 * Choisit, dans la note du producteur, la phrase qui motive REELLEMENT le
 * classement.
 *
 * Sans ça, la justification citait les 110 premiers caracteres de la note,
 * c'est-a-dire la robe et le nez, alors que la demande portait sur la texture.
 * Le systeme avait l'air de justifier sans jamais repondre a la question posee.
 *
 * Aucune reecriture: on selectionne une phrase existante, on ne la reformule
 * pas. C'est de la selection, pas de la generation.
 */
export async function choisirExtrait(
  note: string,
  vecteurRequete: readonly number[] | null,
  fournisseur: FournisseurEmbedding,
): Promise<string | null> {
  if (!vecteurRequete) return null;

  const phrases = decouperEnPhrases(note);
  if (phrases.length <= 1) return null;

  const vecteurs = await fournisseur.embed(phrases);
  let meilleure = -Infinity;
  let gagnante: string | null = null;

  for (const [i, phrase] of phrases.entries()) {
    const v = vecteurs[i];
    if (!v) continue;
    let score = 0;
    for (let d = 0; d < vecteurRequete.length; d++) score += (vecteurRequete[d] ?? 0) * (v[d] ?? 0);
    if (score > meilleure) {
      meilleure = score;
      gagnante = phrase;
    }
  }

  // Une phrase qui ne correspond a rien n'est pas une justification.
  return meilleure > 0.05 ? gagnante : null;
}

function decouperEnPhrases(texte: string): string[] {
  return texte
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 15);
}
