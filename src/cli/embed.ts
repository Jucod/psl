import { db, fermer, versVecteur } from '../db/client.js';
import { config } from '../config/domaine.js';
import { fournisseurEmbedding } from '../embeddings/index.js';
import { embedAvecCache } from '../embeddings/cache.js';
import { enregistrerSignature } from '../embeddings/signature.js';

const pool = db();
const fournisseur = fournisseurEmbedding();
console.log(`embeddings: provider "${fournisseur.nom}", ${config.dimensionEmbedding} dims`);

// --- profils d'appellation (niveau APPELLATION) ------------------------------
const profils = await pool.query<{ appellation_id: string; couleur: string; texte_profil: string }>(
  'SELECT appellation_id, couleur, texte_profil FROM appellation_profils ORDER BY appellation_id, couleur',
);
if (profils.rowCount) {
  const vecteurs = await embedAvecCache(fournisseur, profils.rows.map((r) => r.texte_profil));
  for (const [i, r] of profils.rows.entries()) {
    await pool.query(
      'UPDATE appellation_profils SET embedding = $1 WHERE appellation_id = $2 AND couleur = $3',
      [versVecteur(vecteurs[i]!), r.appellation_id, r.couleur],
    );
  }
}
console.log(`  profils d appellation : ${profils.rowCount}`);

// --- cuvees (niveau CUVEE uniquement) ---------------------------------------
// On n'embedde QUE les cuvees qui portent une note de producteur. Les autres
// gardent embedding NULL et embedding_niveau='appellation': la recherche
// utilisera le vecteur du profil AOC et l'annoncera. Concatener le profil dans
// le vecteur de chaque cuvee les rendrait colineaires et ecraserait le
// classement, ce qui est precisement le piege du jalon 2.
const cuvees = await pool.query<{ id: string; embedding_source: string }>(
  `SELECT id, embedding_source FROM cuvees
    WHERE embedding_niveau = 'cuvee' AND embedding_source IS NOT NULL
    ORDER BY id`,
);
if (cuvees.rowCount) {
  const vecteurs = await embedAvecCache(fournisseur, cuvees.rows.map((r) => r.embedding_source));
  for (const [i, r] of cuvees.rows.entries()) {
    await pool.query('UPDATE cuvees SET embedding = $1 WHERE id = $2', [
      versVecteur(vecteurs[i]!), r.id,
    ]);
  }
}

const sansNote = await pool.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM cuvees WHERE embedding_niveau = 'appellation'`,
);
console.log(`  cuvees avec note      : ${cuvees.rowCount}`);
console.log(`  cuvees sur profil AOC : ${sansNote.rows[0]!.n}`);

const signature = await enregistrerSignature(pool, fournisseur);
console.log(`  signature             : ${signature}`);

await fermer();
