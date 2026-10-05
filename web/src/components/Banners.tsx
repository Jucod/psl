import type { Search } from '../types.ts';

/** Relaxation is never silent: it takes the top of the answer. */
export function RelaxationBanner({ search }: { search: Search }) {
  if (search.relaxations.length === 0) return null;
  return (
    <div className="banner banner-relaxed">
      <strong>Criteres elargis.</strong> Aucun resultat avec votre demande initiale.
      <ul>
        {search.relaxations.map((r, i) => <li key={i}>{r.announcement}</li>)}
      </ul>
    </div>
  );
}

export function RefusalBanner({ search }: { search: Search }) {
  if (search.status !== 'refused' || !search.refusal) return null;
  return (
    <div className="banner banner-refused">
      <strong>Hors catalogue.</strong> {search.refusal.message}
      {search.refusal.source && (
        <p>
          <a href={search.refusal.source.url} target="_blank" rel="noreferrer noopener">
            {search.refusal.source.label}
          </a>
          {search.refusal.source.authority && <span> · {search.refusal.source.authority}</span>}
        </p>
      )}
    </div>
  );
}

export function DegradedBanner({ reason }: { reason: string | null }) {
  return (
    <div className="banner banner-degraded">
      <strong>Interpretation degradee.</strong> Le modele n'a pas rendu de sortie
      conforme ; la demande a ete analysee par le parseur de regles.
      {reason && <span className="detail"> ({reason})</span>}
    </div>
  );
}

/**
 * "No wine under 20 €" and "I have the price of no wine" are two different
 * answers. Mistaking the second for the first is an unfounded statement,
 * exactly what this system exists to avoid.
 */
export function UndecidableBanner({ search }: { search: Search }) {
  if (search.undecidableFilters.length === 0) return null;
  return (
    <div className="banner banner-undecidable">
      <strong>Donnee manquante, pas absence de correspondance.</strong> Le catalogue
      ne porte l'information demandee pour aucune des {search.catalogSize} cuvee(s) :
      <ul>
        {search.undecidableFilters.map((f) => <li key={f.field}>{f.label.toLowerCase()}</li>)}
      </ul>
      Le systeme ne peut pas repondre sur ce critere, et ne pretend pas le contraire.
    </div>
  );
}

export function PairingsBanner({ search }: { search: Search }) {
  if (search.dishPairings.length === 0) return null;
  return (
    <div className="banner banner-pairings">
      <strong>Accords deduits.</strong> Ces accords viennent du profil de
      l'appellation, pas d'une caracteristique des cuvees ci-dessus.
      <div className="chips">
        {search.dishPairings.map((a) => (
          <span key={a.label} className="chip chip-derived">{a.label}</span>
        ))}
      </div>
    </div>
  );
}
