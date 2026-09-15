import type { Filtres } from '../schema/filtres.js';

export interface SourceCitee {
  id: string;
  type: string;
  label: string;
  url: string;
  autorite: string | null;
  date_releve: string;
}

export interface AccordDerive {
  libelle: string;
  categorie: string;
  statut: 'derive';
  derive_de: string;
}

export interface Resultat {
  id: string;
  nom_cuvee: string;
  domaine: string;
  domaine_id: string;
  commune: string | null;
  appellation_id: string;
  couleur: string;
  millesime: number | null;
  degre: number | null;
  elevage: string | null;
  prix_ttc: number | null;
  prix_date_releve: string | null;
  bio: boolean | null;
  certification: string | null;
  assemblage: { cepage: string; pct: number | null }[];
  fiche_url: string | null;

  /**
   * Note du producteur, recopiee telle quelle. null quand aucune fiche
   * technique n'est indexee: dans ce cas `niveau` vaut 'appellation' et
   * `profil_appellation` porte le repli, annonce comme tel.
   */
  note_degustation: string | null;
  note_source: SourceCitee | null;
  accords_producteur: string[];

  /** 'cuvee' = le classement s'appuie sur la note du producteur.
   *  'appellation' = repli sur le profil AOC, a annoncer. */
  niveau: 'cuvee' | 'appellation';
  profil_appellation: {
    texte: string;
    source: SourceCitee;
    section: string | null;
  } | null;

  score: number;
  /** Vrai si la note vient d'une fixture de developpement. */
  fixture: boolean;
}

export interface Relachement {
  champ: string;
  libelle: string;
  annonce: string;
}

export type StatutRecherche = 'ok' | 'refus_hors_catalogue' | 'vide';

export interface ResultatRecherche {
  statut: StatutRecherche;
  /** Rempli quand statut = 'refus_hors_catalogue'. */
  refus: { message: string; source: SourceCitee | null } | null;
  filtresDemandes: Filtres;
  filtresAppliques: Filtres;
  /** Jamais vide sans que l'utilisateur en soit informe. */
  relachements: Relachement[];
  classement: 'vectoriel' | 'lexicographique';
  resultats: Resultat[];
  /** Accords d'appellation correspondant au plat demande. Toujours DERIVES. */
  accordsPourLePlat: AccordDerive[];
  /** Nombre de cuvees dans le catalogue pour l'appellation et la couleur visees. */
  tailleCatalogue: number;
  /** Problemes d'exploitation a remonter a l'operateur, pas a l'utilisateur. */
  avertissements: string[];
}
