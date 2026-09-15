/**
 * Configuration du domaine metier.
 *
 * C'est le SEUL fichier du projet ou le mot "vin" a un sens. Le moteur de
 * recherche (src/moteur/) ne connait ni "couleur", ni "millesime", ni
 * "appellation": il consomme les declarations ci-dessous.
 *
 * Reutiliser le moteur sur un catalogue de pieces detachees = reecrire ce
 * fichier et changer les donnees. Pas de couche de plugins, pas de modele
 * d'entite generique: un objet declaratif, et c'est tout.
 */

export type Operateur =
  | 'egal'
  | 'max'
  | 'min'
  | 'booleen'
  | 'jointure_un'     // au moins une des valeurs presente dans la table liee
  | 'jointure_aucun'; // aucune des valeurs presente dans la table liee

export interface Jointure {
  readonly table: string;
  readonly cleEtrangere: string;
  readonly colonne: string;
}

/** Resultat d'une tentative de relachement. null = on ne peut pas aller plus loin. */
export interface Relachement {
  readonly valeur: unknown;
  /** Phrase affichee a l'utilisateur. L'elargissement n'est JAMAIS silencieux. */
  readonly annonce: string;
}

export interface ChampFiltre {
  readonly cle: string;
  readonly libelle: string;
  readonly operateur: Operateur;
  readonly colonne?: string;
  readonly jointure?: Jointure;
  /** Rendu de la valeur dans le panneau de filtres actifs du front. */
  readonly rendu: (valeur: any) => string;
  /**
   * Relachement d'un cran. Reçoit la valeur courante et la valeur d'origine
   * (pour plafonner la derive). Retourne null si le champ ne peut plus etre
   * relache, auquel cas le moteur passe au champ suivant de l'ordre.
   */
  readonly relacher?: (courante: any, origine: any) => Relachement | null;
}

export interface ConfigDomaine {
  readonly tablePrincipale: string;
  readonly clePrimaire: string;
  readonly champs: readonly ChampFiltre[];
  /** Ordre d'elargissement, une contrainte a la fois. */
  readonly ordreElargissement: readonly string[];
  /**
   * Verification de couverture du catalogue. Quand la combinaison demandee
   * n'existe pas dans la table de couverture, le systeme REFUSE au lieu de
   * proposer un approchant. C'est un resultat de requete, pas une consigne
   * de prompt: testable sans LLM.
   */
  readonly couverture: {
    readonly table: string;
    readonly cles: readonly { readonly filtre: string; readonly colonne: string }[];
    readonly message: (valeurs: Record<string, unknown>, disponibles: string[]) => string;
  };
  readonly maxResultats: number;
  readonly poidsRejet: number;
  readonly dimensionEmbedding: number;
  /**
   * Ecart minimal entre le meilleur et le moins bon score pour qu'un
   * classement vectoriel soit considere comme discriminant.
   *
   * C'est un seuil d'ECART, pas de similarite absolue, et la nuance compte.
   * Sur une demande de rejet seul ("rien de tannique"), le vecteur de requete
   * pointe a l'oppose du concept refuse: tous les cosinus sont negatifs alors
   * que l'ordre, lui, est parfaitement informatif. Un plancher absolu
   * n'etait jamais franchi et le rejet ne servait qu'a selectionner, jamais a
   * classer. Ce qui fait un classement, c'est la separation.
   */
  readonly seuilDiscrimination: number;
}

const EUROS = (n: number) => `${Number(n).toFixed(2).replace(/\.00$/, '')} €`;

export const config: ConfigDomaine = {
  tablePrincipale: 'cuvees',
  clePrimaire: 'id',

  champs: [
    {
      cle: 'appellation',
      libelle: 'Appellation',
      operateur: 'egal',
      colonne: 'appellation_id',
      rendu: (v) => String(v),
      // Volontairement non relachable. Voir ordreElargissement ci-dessous.
      relacher: () => null,
    },
    {
      cle: 'couleur',
      libelle: 'Couleur',
      operateur: 'egal',
      colonne: 'couleur',
      rendu: (v) => String(v),
    },
    {
      cle: 'prix_max',
      libelle: 'Budget maximum',
      operateur: 'max',
      colonne: 'prix_ttc',
      rendu: (v) => `jusqu'a ${EUROS(v)}`,
      // Par paliers de 25 %, plafonne a +50 % du budget initial.
      relacher: (courante: number, origine: number) => {
        // Sans cette garde, un origine absent rend la comparaison NaN, donc
        // fausse, donc le plafond de derive ne s'applique jamais.
        if (!Number.isFinite(origine)) return null;
        const suivante = Math.round(courante * 1.25 * 100) / 100;
        if (suivante > origine * 1.5 + 0.001) return null;
        return {
          valeur: suivante,
          annonce: `budget porte de ${EUROS(courante)} a ${EUROS(suivante)}`,
        };
      },
    },
    {
      cle: 'prix_min',
      libelle: 'Budget minimum',
      operateur: 'min',
      colonne: 'prix_ttc',
      rendu: (v) => `a partir de ${EUROS(v)}`,
    },
    {
      cle: 'millesime_min',
      libelle: 'Millesime le plus ancien',
      operateur: 'min',
      colonne: 'millesime',
      rendu: (v) => `${v} ou plus recent`,
      relacher: (courante: number, origine: number) => {
        if (!Number.isFinite(origine)) return null;
        const suivante = courante - 1;
        if (suivante < origine - 3) return null;
        return { valeur: suivante, annonce: `millesime elargi jusqu'a ${suivante}` };
      },
    },
    {
      cle: 'millesime_max',
      libelle: 'Millesime le plus recent',
      operateur: 'max',
      colonne: 'millesime',
      rendu: (v) => `${v} ou plus ancien`,
      relacher: (courante: number, origine: number) => {
        if (!Number.isFinite(origine)) return null;
        const suivante = courante + 1;
        if (suivante > origine + 3) return null;
        return { valeur: suivante, annonce: `millesime elargi jusqu'a ${suivante}` };
      },
    },
    {
      cle: 'bio',
      libelle: 'Agriculture biologique',
      operateur: 'booleen',
      colonne: 'bio',
      rendu: (v) => (v ? 'bio uniquement' : 'bio ou conventionnel'),
    },
    {
      cle: 'cepages_inclus',
      libelle: 'Cepages souhaites',
      operateur: 'jointure_un',
      jointure: { table: 'cuvee_cepages', cleEtrangere: 'cuvee_id', colonne: 'cepage' },
      rendu: (v: string[]) => v.join(', '),
      relacher: () => null,
    },
    {
      cle: 'cepages_exclus',
      libelle: 'Cepages exclus',
      operateur: 'jointure_aucun',
      jointure: { table: 'cuvee_cepages', cleEtrangere: 'cuvee_id', colonne: 'cepage' },
      rendu: (v: string[]) => `sans ${v.join(', ')}`,
    },
  ],

  /**
   * Budget, puis millesime. L'appellation ferme la marche mais n'est PAS
   * relachable (relacher: () => null): dans un catalogue mono-AOC, relacher
   * l'appellation ne peut rien ramener, et c'est de toute façon la partie la
   * plus explicite d'une demande. Le moteur produit alors un refus annonce.
   * Le barreau reste declare pour le jour ou le catalogue sera multi-AOC.
   */
  ordreElargissement: ['prix_max', 'millesime_min', 'millesime_max', 'appellation'],

  couverture: {
    table: 'appellation_couleurs',
    cles: [
      { filtre: 'appellation', colonne: 'appellation_id' },
      { filtre: 'couleur', colonne: 'couleur' },
    ],
    message: (valeurs, disponibles) =>
      `L'appellation ${valeurs.appellation} ne couvre pas les ${valeurs.couleur}s. ` +
      `Elle ne produit que : ${disponibles.join(', ')}.`,
  },

  maxResultats: 3,

  /**
   * Poids du vecteur de rejet. Le vecteur de requete vaut
   * normalise(v(souhaites) - REJET * v(refuses)).
   * A 1.0 le rejet ecrase la demande; a 0 il est inoperant. 0.7 penalise
   * nettement sans inverser le classement.
   */
  poidsRejet: 0.7,
  dimensionEmbedding: 1536,
  seuilDiscrimination: 0.05,
};

/** Acces indexe, utilise partout dans le moteur. */
export const champParCle = new Map(config.champs.map((c) => [c.cle, c]));
