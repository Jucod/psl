/**
 * Lexique oenologique francais.
 *
 * Deux usages, tous deux cantonnes a la configuration (le moteur ne le voit
 * jamais en dur):
 *  1. expansion des tokens pour le provider d'embedding local, qui n'a pas
 *     de modele pre-entraine pour savoir que "souple" et "fondu" sont proches;
 *  2. parseur deterministe du mode degrade (src/llm/local.ts), quand aucun
 *     LLM n'est joignable ou que sa sortie ne valide pas le schema.
 *
 * Changer de domaine metier = remplacer ce fichier.
 */

/** Familles de descripteurs. Les membres d'une famille s'attirent au cosinus. */
export const FAMILLES: Record<string, string[]> = {
  tannique: ['tannique', 'tanin', 'tanins', 'charpente', 'charpente', 'structure', 'structure', 'corse', 'puissant', 'ferme', 'austere', 'muscle', 'robuste'],
  souple: ['souple', 'fondu', 'rond', 'ronde', 'soyeux', 'veloute', 'moelleux', 'coulant', 'gouleyant', 'caressant', 'fin', 'delicat', 'tendre'],
  frais: ['frais', 'fraiche', 'fraicheur', 'vif', 'vive', 'tendu', 'nerveux', 'acidite', 'croquant', 'eclatant', 'minerale', 'mineral', 'salin'],
  fruits_rouges: ['fruits rouges', 'cerise', 'fraise', 'framboise', 'groseille', 'griotte', 'fruit rouge'],
  fruits_noirs: ['fruits noirs', 'mure', 'cassis', 'myrtille', 'prunelle', 'fruit noir'],
  epices: ['epice', 'epices', 'epicee', 'poivre', 'reglisse', 'cannelle', 'muscade', 'girofle', 'poivre noir'],
  garrigue: ['garrigue', 'thym', 'romarin', 'laurier', 'ciste', 'herbes', 'herbes seches', 'menthol'],
  boise: ['boise', 'fut', 'barrique', 'chene', 'vanille', 'torrefaction', 'cacao', 'grille', 'toaste', 'fume'],
  floral: ['floral', 'violette', 'pivoine', 'rose', 'fleurs'],
  concentre: ['concentre', 'dense', 'riche', 'ample', 'genereux', 'puissant', 'profond'],
  leger: ['leger', 'legere', 'aerien', 'subtil', 'fluide', 'digeste'],
  garde: ['garde', 'vieillissement', 'potentiel', 'evolution', 'tenue'],
};

/**
 * Desinence francaise minimale.
 *
 * Sans elle, "fondus" ne rejoint pas "fondu" et "coulante" ne rejoint pas
 * "coulant": les notes de degustation sont ecrites en accord avec le nom
 * qu'elles qualifient, le lexique est au singulier masculin, et le classement
 * rate la moitie de ses correspondances. Trois regles suffisent sur ce corpus;
 * ce n'est pas un stemmer generaliste et ça n'a pas a l'etre.
 *
 * Appliquee des DEUX cotes (lexique et texte), donc toute sur-troncature reste
 * symetrique et sans effet sur les appariements.
 */
export function racine(mot: string): string {
  let t = mot;
  if (t.length > 4 && t.endsWith('aux')) t = t.slice(0, -3) + 'al';
  if (t.length > 3 && t.endsWith('s')) t = t.slice(0, -1);
  if (t.length > 3 && t.endsWith('e')) t = t.slice(0, -1);
  return t;
}

/** Racine -> famille. Construit une fois. */
export const FAMILLE_PAR_MOT: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [famille, mots] of Object.entries(FAMILLES)) {
    for (const mot of mots) {
      m.set(mot.split(' ').map(racine).join(' '), famille);
    }
  }
  return m;
})();

/** Mots vides francais + bruit specifique aux demandes de conseil. */
export const MOTS_VIDES = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd', 'l', 'et', 'ou', 'a', 'au', 'aux',
  'en', 'pour', 'avec', 'sans', 'sur', 'dans', 'par', 'plus', 'moins', 'tres', 'trop', 'pas',
  'je', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'cherche', 'voudrais', 'aimerais',
  'veux', 'faut', 'sur', 'qui', 'que', 'quoi', 'est', 'sont', 'ce', 'cette', 'ces', 'son',
  'sa', 'ses', 'leur', 'mon', 'ma', 'mes', 'vin', 'bouteille', 'vins', 'bouteilles',
]);

/** Plats reconnus -> categorie d'accord dans appellation_accords. */
export const PLATS: Record<string, { categorie: 'viande' | 'fromage' | 'poisson' | 'autre'; termes: string[] }> = {
  agneau: { categorie: 'viande', termes: ['agneau', 'gigot', 'souris d agneau', 'cotelettes'] },
  boeuf: { categorie: 'viande', termes: ['boeuf', 'entrecote', 'cote de boeuf', 'grillade', 'grillades', 'steak'] },
  gibier: { categorie: 'viande', termes: ['gibier', 'sanglier', 'chevreuil', 'perdreau', 'faisan'] },
  daube: { categorie: 'viande', termes: ['daube', 'mijote', 'ragout', 'civet', 'pot au feu'] },
  volaille: { categorie: 'viande', termes: ['volaille', 'poulet', 'magret', 'canard', 'pintade'] },
  charcuterie: { categorie: 'viande', termes: ['charcuterie', 'saucisson', 'jambon', 'pate'] },
  fromage: { categorie: 'fromage', termes: ['fromage', 'pelardon', 'roquefort', 'tomme', 'chevre', 'brebis'] },
  // 'loup' est volontairement absent: l'appellation s'appelle Pic Saint-Loup,
  // et toute demande la citant se retrouvait classee en accord poisson.
  // Le cout d'un faux positif ici est superieur au gain d'un vrai positif.
  poisson: { categorie: 'poisson', termes: ['poisson', 'brandade', 'bourride', 'tielle', 'daurade', 'bar de ligne', 'saumon', 'thon', 'cabillaud'] },
  aperitif: { categorie: 'autre', termes: ['aperitif', 'apero', 'tapas', 'grignotage'] },
};

/**
 * Cepages courants ABSENTS de l'appellation.
 *
 * Sans cette liste, "avez-vous du chardonnay ?" ne produisait aucun filtre a
 * refuser: le parseur ne reconnaissait que les cepages du catalogue, la
 * contrainte s'evaporait, et le systeme repondait trois rouges. Les nommer
 * permet au moteur de REFUSER en citant l'encepagement du cahier des charges,
 * au lieu de servir un approchant.
 *
 * Liste a etendre selon les demandes reellement reçues; elle n'a pas a etre
 * exhaustive pour etre utile.
 */
export const CEPAGES_HORS_APPELLATION = [
  'chardonnay', 'viognier', 'roussanne', 'marsanne', 'bourboulenc', 'clairette',
  'vermentino', 'rolle', 'sauvignon', 'chenin', 'riesling', 'gewurztraminer',
  'pinot noir', 'cabernet sauvignon', 'cabernet franc', 'merlot', 'gamay',
  'malbec', 'tannat', 'nebbiolo', 'sangiovese', 'tempranillo', 'muscat',
  'grenache blanc', 'picpoul', 'terret', 'aligote', 'melon de bourgogne',
];

/** Retire les accents et abaisse la casse. */
export function normaliser(texte: string): string {
  return texte
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Tokenise en retirant les mots vides. Les bigrammes utiles sont conserves. */
export function tokeniser(texte: string): string[] {
  const base = normaliser(texte)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1 && !MOTS_VIDES.has(t))
    .map(racine);

  const bigrammes: string[] = [];
  for (let i = 0; i < base.length - 1; i++) {
    const bi = `${base[i]} ${base[i + 1]}`;
    if (FAMILLE_PAR_MOT.has(bi)) bigrammes.push(bi);
  }
  return [...base, ...bigrammes];
}

/**
 * Familles opposees. Sert au traitement de la NEGATION.
 *
 * Un sac de mots ne sait pas nier: "pas trop tannique" et "tannique" partagent
 * les memes dimensions. La negation est donc resolue en amont, au parsing, en
 * remplaçant le descripteur nie par son oppose declare. C'est un choix
 * explicite plutot qu'un espoir place dans le vectoriel.
 */
export const OPPOSES: Record<string, string> = {
  tannique: 'souple',
  souple: 'tannique',
  concentre: 'leger',
  leger: 'concentre',
  boise: 'frais',
};

/**
 * Marqueurs de negation ou d'attenuation.
 *
 * Cherches dans les mots qui PRECEDENT un descripteur, jamais par sous-chaine:
 * "euros" contient "ros", racine de "rose", et un includes() brut classait donc
 * une demande de budget dans la famille florale.
 *
 * "plus" est volontairement absent: "plus de tanins" demande davantage.
 */
export const MARQUEURS_NEGATION = new Set([
  'pas', 'peu', 'sans', 'moins', 'trop', 'aucun', 'aucune', 'eviter', 'evite', 'ni',
]);

/** Portee d'un marqueur, en nombre de mots vers la droite. */
export const PORTEE_NEGATION = 3;

/** Decoupe en mots pleins, sans retrait des mots vides, racines appliquees. */
export function mots(texte: string): { brut: string[]; racines: string[] } {
  const brut = normaliser(texte).replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
  return { brut, racines: brut.map(racine) };
}
