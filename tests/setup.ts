import { beforeAll } from 'vitest';

// Les tests tournent sur la base de developpement, fixtures comprises: sans
// notes de degustation, il n'y a rien a classer et le jalon 2 ne serait pas
// testable. Les cas qui verifient le comportement SANS fixture le font
// explicitement, en passant autoriserFixtures: false au moteur.
process.env.PSL_AUTORISER_FIXTURES = '1';
process.env.PSL_EMBEDDING_PROVIDER ??= 'local';
process.env.PSL_LLM_PROVIDER ??= 'local';
process.env.DATABASE_URL ??= 'postgres://psl:psl@127.0.0.1:5432/psl';

beforeAll(async () => {
  const { db } = await import('../src/db/client.js');
  try {
    await db().query('SELECT 1 FROM cuvees LIMIT 1');
  } catch {
    throw new Error(
      'base non initialisee. Lance: bash scripts/bootstrap-postgres-local.sh && npm run setup',
    );
  }

  // Modifier src/config/lexique.ts change la vectorisation des notes, mais pas
  // les vecteurs deja stockes. Le moteur detecte l'ecart et refuse alors de
  // classer au vectoriel, ce qui fait echouer les cas de classement avec un
  // message trompeur. Le provider local est deterministe, instantane et hors
  // ligne: on recalcule plutot que d'exiger de l'operateur qu'il y pense.
  const { fournisseurEmbedding } = await import('../src/embeddings/index.js');
  const { verifierSignature, enregistrerSignature } = await import('../src/embeddings/signature.js');
  const fournisseur = fournisseurEmbedding();

  const etat = await verifierSignature(db(), fournisseur);
  if (!etat.aJour) {
    if (!fournisseur.deterministe) {
      throw new Error(
        `embeddings perimes et provider "${fournisseur.nom}" facturant a l'appel: ` +
        `lance "npm run db:embed" volontairement. Detail: ${etat.message}`,
      );
    }
    const { versVecteur } = await import('../src/db/client.js');
    const cuvees = await db().query<{ id: string; embedding_source: string }>(
      `SELECT id, embedding_source FROM cuvees
        WHERE embedding_niveau = 'cuvee' AND embedding_source IS NOT NULL`,
    );
    const vecteurs = await fournisseur.embed(cuvees.rows.map((r) => r.embedding_source));
    for (const [i, r] of cuvees.rows.entries()) {
      await db().query('UPDATE cuvees SET embedding = $1 WHERE id = $2', [versVecteur(vecteurs[i]!), r.id]);
    }
    const profils = await db().query<{ appellation_id: string; couleur: string; texte_profil: string }>(
      'SELECT appellation_id, couleur, texte_profil FROM appellation_profils',
    );
    const vp = await fournisseur.embed(profils.rows.map((r) => r.texte_profil));
    for (const [i, r] of profils.rows.entries()) {
      await db().query(
        'UPDATE appellation_profils SET embedding = $1 WHERE appellation_id = $2 AND couleur = $3',
        [versVecteur(vp[i]!), r.appellation_id, r.couleur],
      );
    }
    await enregistrerSignature(db(), fournisseur);
  }
});
