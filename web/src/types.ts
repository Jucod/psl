export interface Source {
  id: string;
  type: string;
  label: string;
  url: string;
  autorite: string | null;
  date_releve: string;
}

export interface Resultat {
  id: string;
  nom_cuvee: string;
  domaine: string;
  commune: string | null;
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
  note_degustation: string | null;
  note_tronquee: boolean;
  note_source: Source | null;
  accords_producteur: string[];
  niveau: 'cuvee' | 'appellation';
  profil_appellation: { texte: string; source: Source; section: string | null } | null;
  score: number;
  fixture: boolean;
  extrait_pertinent: string | null;
}

export interface Filtres {
  appellation: string | null;
  couleur: string | null;
  prix_min: number | null;
  prix_max: number | null;
  millesime_min: number | null;
  millesime_max: number | null;
  bio: boolean | null;
  cepages_inclus: string[];
  cepages_exclus: string[];
  plat: string | null;
  descripteurs: string[];
  descripteurs_exclus: string[];
}

export interface Recherche {
  statut: 'ok' | 'refus_hors_catalogue' | 'vide';
  refus: { message: string; source: Source | null } | null;
  filtresDemandes: Filtres;
  filtresAppliques: Filtres;
  relachements: { champ: string; libelle: string; annonce: string }[];
  classement: 'vectoriel' | 'lexicographique';
  resultats: Resultat[];
  accordsPourLePlat: { libelle: string; categorie: string; statut: string; derive_de: string }[];
  tailleCatalogue: number;
}

export interface ReponseRecherche {
  statut: string;
  texte: string;
  degrade?: boolean;
  raison_degrade?: string | null;
  fixtures_actives?: boolean;
  latence_ms?: number;
  recherche: Recherche | null;
}

export interface Catalogue {
  appellations: { id: string; nom: string; source_label: string; source_url: string }[];
  couleurs: string[];
  cepages: { code: string; libelle: string }[];
  bornes: { prix_min: number | null; prix_max: number | null; millesime_min: number | null; millesime_max: number | null };
  champs: { cle: string; libelle: string; operateur: string }[];
  ordre_elargissement: string[];
}
