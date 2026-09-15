import type { Catalogue, Filtres, ReponseRecherche } from './types.ts';

async function json<T>(reponse: Response): Promise<T> {
  const corps = await reponse.json();
  if (!reponse.ok && !corps.statut) throw new Error(corps.message ?? `HTTP ${reponse.status}`);
  return corps as T;
}

export async function chargerCatalogue(): Promise<Catalogue> {
  return json<Catalogue>(await fetch('/api/catalogue'));
}

/**
 * `filtres` non nul court-circuite l'appel LLM 1: c'est le chemin emprunte
 * quand l'utilisateur corrige les filtres a la main. La demande initiale reste
 * envoyee pour le journal, mais elle n'est plus interpretee.
 */
export async function rechercher(message: string, filtres?: Filtres): Promise<ReponseRecherche> {
  return json<ReponseRecherche>(
    await fetch('/api/recherche', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(filtres ? { message, filtres } : { message }),
    }),
  );
}
