import type { Recherche } from '../types.ts';

/** L'elargissement n'est jamais silencieux: il occupe le haut de la reponse. */
export function BandeauElargissement({ recherche }: { recherche: Recherche }) {
  if (recherche.relachements.length === 0) return null;
  return (
    <div className="bandeau bandeau-elargissement">
      <strong>Criteres elargis.</strong> Aucun resultat avec votre demande initiale.
      <ul>
        {recherche.relachements.map((r, i) => <li key={i}>{r.annonce}</li>)}
      </ul>
    </div>
  );
}

export function BandeauRefus({ recherche }: { recherche: Recherche }) {
  if (recherche.statut !== 'refus_hors_catalogue' || !recherche.refus) return null;
  return (
    <div className="bandeau bandeau-refus">
      <strong>Hors catalogue.</strong> {recherche.refus.message}
      {recherche.refus.source && (
        <p>
          <a href={recherche.refus.source.url} target="_blank" rel="noreferrer noopener">
            {recherche.refus.source.label}
          </a>
          {recherche.refus.source.autorite && <span> · {recherche.refus.source.autorite}</span>}
        </p>
      )}
    </div>
  );
}

export function BandeauDegrade({ raison }: { raison: string | null }) {
  return (
    <div className="bandeau bandeau-degrade">
      <strong>Interpretation degradee.</strong> Le modele n'a pas rendu de sortie
      conforme ; la demande a ete analysee par le parseur de regles.
      {raison && <span className="detail"> ({raison})</span>}
    </div>
  );
}

/**
 * "Aucun vin sous 20 €" et "je n'ai le prix d'aucun vin" sont deux reponses
 * differentes. Confondre la seconde avec la premiere est une affirmation sans
 * fondement, exactement ce que ce systeme existe pour eviter.
 */
export function BandeauIndecidable({ recherche }: { recherche: Recherche }) {
  if (recherche.filtresIndecidables.length === 0) return null;
  return (
    <div className="bandeau bandeau-indecidable">
      <strong>Donnee manquante, pas absence de correspondance.</strong> Le catalogue
      ne porte l'information demandee pour aucune des {recherche.tailleCatalogue} cuvee(s) :
      <ul>
        {recherche.filtresIndecidables.map((f) => <li key={f.champ}>{f.libelle.toLowerCase()}</li>)}
      </ul>
      Le systeme ne peut pas repondre sur ce critere, et ne pretend pas le contraire.
    </div>
  );
}

export function BandeauAccords({ recherche }: { recherche: Recherche }) {
  if (recherche.accordsPourLePlat.length === 0) return null;
  return (
    <div className="bandeau bandeau-accords">
      <strong>Accords deduits.</strong> Ces accords viennent du profil de
      l'appellation, pas d'une caracteristique des cuvees ci-dessus.
      <div className="jetons">
        {recherche.accordsPourLePlat.map((a) => (
          <span key={a.libelle} className="jeton jeton-derive">{a.libelle}</span>
        ))}
      </div>
    </div>
  );
}
