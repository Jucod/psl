import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { config } from './config/domaine.js';
import { env } from './config/env.js';
import { db } from './db/client.js';
import { fournisseurEmbedding } from './embeddings/index.js';
import { construireIndexCepages, codeCepage } from './ingest/util.js';
import { fournisseurLlm, type Usage } from './llm/index.js';
import { texteVectoriel } from './llm/parseur.js';
import { rechercher } from './moteur/recherche.js';
import type { ResultatRecherche } from './moteur/types.js';
import { FILTRES_VIDES, parserFiltresPartiels, type Filtres } from './schema/filtres.js';

const CHEMIN_CEPAGES = new URL('../db/seed/cepages.json', import.meta.url).pathname;

export interface EntreePipeline {
  message: string;
  /** Filtres corriges a la main dans l'UI. Court-circuite l'appel LLM 1. */
  filtresImposes?: unknown;
  ip?: string;
}

export interface SortiePipeline {
  statut: ResultatRecherche['statut'] | 'message_trop_long' | 'schema_invalide';
  texte: string;
  recherche: ResultatRecherche | null;
  degrade: boolean;
  raisonDegrade: string | null;
  usage: Usage;
  latence_ms: number;
  providerLlm: string;
  fixturesActives: boolean;
}

let indexCepages: ReadonlyMap<string, string> | null = null;
async function cepages(): Promise<ReadonlyMap<string, string>> {
  if (!indexCepages) {
    const doc = JSON.parse(await readFile(CHEMIN_CEPAGES, 'utf8'));
    indexCepages = construireIndexCepages(doc.cepages);
  }
  return indexCepages;
}

/**
 * Normalise les valeurs avant le moteur: "shiraz" et "Syrah N" doivent devenir
 * "syrah" avant de toucher un WHERE, sinon le filtre rate en silence.
 * C'est ici, et pas dans le moteur, parce que c'est une question de vocabulaire
 * metier: le moteur reste ignorant du domaine.
 */
export async function normaliserFiltres(f: Filtres): Promise<Filtres> {
  const index = await cepages();
  const normaliserListe = (liste: string[]) =>
    [...new Set(liste.map((c) => codeCepage(c, index)).filter((c): c is string => c !== null))].sort();

  return {
    ...f,
    cepages_inclus: normaliserListe(f.cepages_inclus),
    cepages_exclus: normaliserListe(f.cepages_exclus),
  };
}

/** Appellation retenue quand la demande n'en cite aucune. */
export async function appellationParDefaut(): Promise<string | null> {
  const { rows } = await db().query<{ id: string }>(
    'SELECT id FROM appellations ORDER BY id LIMIT 2',
  );
  // Une seule appellation au catalogue: on la prend par defaut et l'UI
  // l'affiche comme un filtre modifiable. Plusieurs: on ne devine pas.
  return rows.length === 1 ? rows[0]!.id : null;
}

export function hashIp(ip: string): string {
  return createHmac('sha256', env.ipHashSecret()).update(ip).digest('hex').slice(0, 32);
}

export async function executerPipeline(entree: EntreePipeline): Promise<SortiePipeline> {
  const debut = Date.now();
  const llm = fournisseurLlm();
  const fixtures = env.autoriserFixtures();

  const base: Omit<SortiePipeline, 'statut' | 'texte' | 'recherche'> = {
    degrade: false,
    raisonDegrade: null,
    usage: { tokens_in: 0, tokens_out: 0, cout_eur: 0 },
    latence_ms: 0,
    providerLlm: llm.nom,
    fixturesActives: fixtures,
  };

  const maxLongueur = env.maxLongueurMessage();
  if (entree.message.length > maxLongueur) {
    return {
      ...base,
      statut: 'message_trop_long',
      texte: `Message trop long (${entree.message.length} caracteres, maximum ${maxLongueur}).`,
      recherche: null,
      latence_ms: Date.now() - debut,
    };
  }

  const defaut = await appellationParDefaut();

  // --- appel 1, ou filtres imposes par l'utilisateur -----------------------
  let filtres: Filtres;
  let degrade = false;
  let raisonDegrade: string | null = null;
  const usage: Usage = { ...base.usage };

  if (entree.filtresImposes !== undefined) {
    const valide = parserFiltresPartiels(entree.filtresImposes);
    if (!valide.success) {
      return {
        ...base,
        statut: 'schema_invalide',
        texte:
          'Filtres invalides : ' +
          valide.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(', '),
        recherche: null,
        latence_ms: Date.now() - debut,
      };
    }
    filtres = valide.data;
  } else {
    const extraction = await llm.extraireFiltres(entree.message, defaut);
    filtres = extraction.filtres;
    degrade = extraction.degrade;
    raisonDegrade = extraction.raisonDegrade;
    usage.tokens_in += extraction.usage.tokens_in;
    usage.tokens_out += extraction.usage.tokens_out;
    usage.cout_eur += extraction.usage.cout_eur;
  }

  if (filtres.appellation === null && defaut) filtres = { ...filtres, appellation: defaut };
  filtres = await normaliserFiltres(filtres);

  // --- vecteur de la partie floue ------------------------------------------
  // Arithmetique de vecteurs: souhaite moins refuse. Une note qui contient les
  // termes refuses voit son cosinus baisser, ce qu'un simple descripteur
  // oppose ne produit pas quand toutes les notes contiennent le terme nie.
  const textes = texteVectoriel(filtres);
  let vecteur: number[] | null = null;
  if (textes) {
    const fournisseur = fournisseurEmbedding();
    const aEmbedder = [textes.inclus || ' ', ...(textes.exclus ? [textes.exclus] : [])];
    const [vIn, vEx] = await fournisseur.embed(aEmbedder);
    vecteur = vEx ? combiner(vIn!, vEx, config.poidsRejet) : (vIn ?? null);
  }

  // --- requete SQL, executee par le code, jamais par le modele --------------
  const recherche = await rechercher(filtres, {
    vecteurRequete: vecteur,
    autoriserFixtures: fixtures,
  });

  // --- appel 2 --------------------------------------------------------------
  const { texte, usage: usage2 } = await llm.formuler({
    recherche: { ...recherche, filtresAppliques: recherche.filtresAppliques as unknown as Record<string, unknown> },
  });
  usage.tokens_in += usage2.tokens_in;
  usage.tokens_out += usage2.tokens_out;
  usage.cout_eur += usage2.cout_eur;

  return {
    ...base,
    statut: recherche.statut,
    texte,
    recherche,
    degrade,
    raisonDegrade,
    usage,
    latence_ms: Date.now() - debut,
  };
}

/** normalise(a - poids * b). Retourne null si le resultat est degenere. */
export function combiner(a: number[], b: number[], poids: number): number[] | null {
  const v = a.map((x, i) => x - poids * (b[i] ?? 0));
  let somme = 0;
  for (const x of v) somme += x * x;
  const norme = Math.sqrt(somme);
  if (norme < 1e-9) return null;
  return v.map((x) => x / norme);
}

export { FILTRES_VIDES, config };
