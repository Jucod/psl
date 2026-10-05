import { labelOf, type Labels, type WineResult } from '../types.ts';

const euros = (n: number) => `${n.toFixed(2).replace(/[.,]00$/, '')} €`;

/**
 * A card shows three distinct things, and never mixes them:
 *  - the technical facts (blend, alcohol, aging, price + date observed);
 *  - the producer's note, quoted and truncated, with its link;
 *  - failing that, the APPELLATION profile, announced as such.
 * Confusing the last two would be exactly the mistake the brief forbids.
 */
export function ResultCard({ wine: w, rank, labels }: {
  wine: WineResult; rank: number; labels?: Labels;
}) {
  return (
    <article className="card">
      <header className="card-header">
        <span className="rank">{rank}</span>
        <div>
          <h3>
            {w.producer} <span className="wine-name">{w.name}</span>
            {w.vintage && <span className="vintage">{w.vintage}</span>}
          </h3>
          <p className="subtitle">
            {w.commune && <span>{w.commune}</span>}
            <span className={`badge badge-${w.color}`}>{labelOf(labels?.colors, w.color)}</span>
            {w.certification && <span className="badge badge-organic">{w.certification}</span>}
          </p>
        </div>
        {w.price_eur !== null && (
          <div className="price">
            <strong>{euros(w.price_eur)}</strong>
            {w.price_as_of && <small>releve le {w.price_as_of}</small>}
          </div>
        )}
      </header>

      {/* The banner only makes sense when a field from the overlay is ACTUALLY
          shown. When the flag is 0, everything is masked and the fallback
          block on the appellation profile already explains the situation. */}
      {w.fixture && w.tasting_note !== null && (
        <p className="fixture-warning">
          Donnee de developpement : cette note, ce prix et cet assemblage n'ont pas
          ete releves sur une fiche technique de producteur.
        </p>
      )}

      <dl className="facts">
        {w.blend.length > 0 && (
          <>
            <dt>Assemblage</dt>
            <dd>{w.blend.map((b) => (b.pct === null ? b.grape : `${b.grape} ${b.pct}%`)).join(', ')}</dd>
          </>
        )}
        {w.abv !== null && (<><dt>Degre</dt><dd>{w.abv} %</dd></>)}
        {w.aging && (<><dt>Elevage</dt><dd>{w.aging}</dd></>)}
      </dl>

      {w.level === 'wine' && w.tasting_note ? (
        <blockquote className="note">
          {/* When a sentence of the note motivates the ranking, THAT sentence
              is quoted. Showing the whole note as well repeated it, and quoting
              a sentence rather than a paragraph better serves the rule "we
              quote, we do not republish": the full text stays on the estate's
              page. */}
          {w.relevant_excerpt ? (
            <p className="match">
              <span>Correspond a votre demande</span>
              « {w.relevant_excerpt} »
            </p>
          ) : (
            <p>« {w.tasting_note} »</p>
          )}
          <footer>
            {(w.note_truncated || w.relevant_excerpt) && <span className="truncated">extrait · </span>}
            <a href={w.note_source?.url} target="_blank" rel="noreferrer noopener">
              {w.note_source?.label}
            </a>
            {w.note_source && <span className="date"> · releve le {w.note_source.retrieved_on}</span>}
          </footer>
        </blockquote>
      ) : w.appellation_profile ? (
        <blockquote className="note note-appellation">
          <p className="level-warning">
            Aucune fiche technique indexee pour cette cuvee. Ce qui suit decrit
            l'<strong>appellation</strong>, pas ce vin.
          </p>
          <p>{w.appellation_profile.text}</p>
          <footer>
            <a href={w.appellation_profile.source.url} target="_blank" rel="noreferrer noopener">
              {w.appellation_profile.source.label}
            </a>
            {w.appellation_profile.section && <span className="date"> · {w.appellation_profile.section}</span>}
          </footer>
        </blockquote>
      ) : null}

      {w.page_url && (
        <p className="page-link">
          <a href={w.page_url} target="_blank" rel="noreferrer noopener">Fiche du domaine</a>
        </p>
      )}
    </article>
  );
}
