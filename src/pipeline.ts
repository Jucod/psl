import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { config } from './config/domaine.js';
import { env } from './config/env.js';
import { db } from './db/client.js';
import { fournisseurEmbedding } from './embeddings/index.js';
import { construireIndexCepages, codeCepage } from './ingest/util.js';
import { fournisseurLlm, type EntreeFormulation, type Usage } from './llm/index.js';
import { texteVectoriel } from './llm/parseur.js';
import { rechercher } from './moteur/recherche.js';
import { choisirExtrait } from './moteur/justification.js';
import type { ResultatRecherche } from './moteur/types.js';
import { FILTRES_VIDES, parserFiltresPartiels, type Filtres } from './schema/filtres.js';

const CHEMIN_CEPAGES = fileURLToPath(new URL('../db/seed/cepages.json', import.meta.url));

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
export async function normaliserFiltres(
  f: Filtres,
): Promise<{ filtres: Filtres; inconnus: string[] }> {
  const index = await cepages();
  const inconnus: string[] = [];

  /**
   * `signaler` distingue les deux sens, et la distinction compte.
   *
   * Un cepage inconnu DEMANDE est une contrainte que le catalogue ne peut pas
   * satisfaire: le supprimer faisait repondre trois rouges a "avez-vous du
   * chardonnay ?". Il doit produire un refus.
   *
   * Un cepage inconnu EXCLU est une contrainte satisfaite par construction:
   * "un rouge sans chardonnay" a pour bonne reponse trois rouges, pas un refus.
   * Refuser la revenait a ne pas repondre a une demande qu'on honore
   * trivialement, sur une formulation de caviste parfaitement banale.
   */
  const normaliserListe = (liste: string[], signaler: boolean) => {
    const codes: string[] = [];
    for (const denomination of liste) {
      const code = codeCepage(denomination, index);
      if (code === null) {
        if (signaler) inconnus.push(denomination);
      } else {
        codes.push(code);
      }
    }
    return [...new Set(codes)].sort();
  };

  return {
    filtres: {
      ...f,
      cepages_inclus: normaliserListe(f.cepages_inclus, true),
      cepages_exclus: normaliserListe(f.cepages_exclus, false),
    },
    inconnus: [...new Set(inconnus)],
  };
}

/**
 * Refus construit depuis l'encepagement du cahier des charges. Comme le refus
 * de couleur, c'est un resultat de requete, et il cite sa source.
 */
async function refuserCepagesInconnus(
  inconnus: string[],
  appellation: string | null,
): Promise<ResultatRecherche['refus']> {
  if (!appellation) {
    return { message: `Cepage inconnu du catalogue : ${inconnus.join(', ')}.`, source: null };
  }

  const { rows } = await db().query(
    `SELECT a.nom, a.encepagement, s.id, s.type, s.label, s.url, s.autorite,
            s.date_releve::text AS date_releve
       FROM appellations a JOIN sources s ON s.id = a.source_id
      WHERE a.id = $1`,
    [appellation],
  );
  const ligne = rows[0];
  if (!ligne) {
    return { message: `Cepage inconnu du catalogue : ${inconnus.join(', ')}.`, source: null };
  }

  const autorises = new Set<string>();
  for (const bloc of Object.values(ligne.encepagement ?? {})) {
    for (const cle of ['principaux', 'accessoires']) {
      for (const c of (bloc as any)?.[cle] ?? []) autorises.add(String(c));
    }
  }

  return {
    message:
      `${inconnus.join(', ')} : ce cepage n'entre pas dans l'encepagement de ` +
      `l'appellation ${ligne.nom}` +
      (autorises.size
        ? `, qui n'autorise que ${[...autorises].sort().join(', ')}.`
        : '.'),
    source: {
      id: ligne.id, type: ligne.type, label: ligne.label, url: ligne.url,
      autorite: ligne.autorite ?? null, date_releve: ligne.date_releve,
    },
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

  const normalisation = await normaliserFiltres(filtres);
  filtres = normalisation.filtres;

  if (normalisation.inconnus.length > 0) {
    const refus = await refuserCepagesInconnus(normalisation.inconnus, filtres.appellation);
    const recherche: ResultatRecherche = {
      statut: 'refus_hors_catalogue', refus,
      filtresDemandes: filtres, filtresAppliques: filtres,
      relachements: [], classement: 'lexicographique', resultats: [],
      accordsPourLePlat: [], tailleCatalogue: 0, avertissements: [],
      filtresIndecidables: [],
    };
    const { texte } = await llm.formuler(entreeFormulation(recherche));
    return {
      ...base, statut: 'refus_hors_catalogue', texte, recherche,
      degrade, raisonDegrade, usage, latence_ms: Date.now() - debut,
    };
  }

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

  // --- justification: quelle phrase de la note motive le classement ? -------
  // Fait ici et non dans le moteur: c'est une question de restitution, et le
  // pipeline detient deja le vecteur de requete. Cela garde intacte la barriere
  // de type de EntreeFormulation, qui ne doit jamais voir les descripteurs.
  if (vecteur) {
    const fournisseur = fournisseurEmbedding();
    await Promise.all(
      recherche.resultats.map(async (c) => {
        if (!c.note_degustation) return;
        c.extrait_pertinent = await choisirExtrait(c.note_degustation, vecteur, fournisseur);
      }),
    );
  }

  // --- appel 2 --------------------------------------------------------------
  const { texte, usage: usage2 } = await llm.formuler(entreeFormulation(recherche));
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

/**
 * Construit l'entree de l'appel 2 champ par champ.
 *
 * Un spread `{ ...recherche }` laissait `filtresDemandes` - donc les
 * descripteurs, et une appellation en texte libre - PHYSIQUEMENT present dans
 * l'objet remis au modele. TypeScript ne verifie pas les proprietes en trop sur
 * un spread : la "barriere de type" n'existait qu'a la lecture, et seule la
 * liste blanche de donneesFormulation protegeait vraiment. Enumerer rend la
 * barriere reelle au runtime.
 */
function entreeFormulation(recherche: ResultatRecherche): EntreeFormulation {
  return {
    recherche: {
      statut: recherche.statut,
      refus: recherche.refus,
      relachements: recherche.relachements,
      classement: recherche.classement,
      resultats: recherche.resultats,
      accordsPourLePlat: recherche.accordsPourLePlat,
      tailleCatalogue: recherche.tailleCatalogue,
      avertissements: recherche.avertissements,
      filtresIndecidables: recherche.filtresIndecidables,
      filtresAppliques: {},
    },
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
