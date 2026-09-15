import type { Resultat } from '../types.ts';

const euros = (n: number) => `${n.toFixed(2).replace(/[.,]00$/, '')} €`;

/**
 * Une carte affiche trois choses distinctes, et ne les melange jamais:
 *  - les faits techniques (assemblage, degre, elevage, prix + date de releve);
 *  - la note du producteur, citee et tronquee, avec son lien;
 *  - a defaut, le profil de l'APPELLATION, annonce comme tel.
 * Confondre les deux derniers serait exactement la faute que le brief interdit.
 */
export function CarteResultat({ c, rang }: { c: Resultat; rang: number }) {
  return (
    <article className="carte">
      <header className="carte-entete">
        <span className="rang">{rang}</span>
        <div>
          <h3>
            {c.domaine} <span className="cuvee">{c.nom_cuvee}</span>
            {c.millesime && <span className="millesime">{c.millesime}</span>}
          </h3>
          <p className="sous-titre">
            {c.commune && <span>{c.commune}</span>}
            <span className={`pastille pastille-${c.couleur}`}>{c.couleur}</span>
            {c.certification && <span className="pastille pastille-bio">{c.certification}</span>}
          </p>
        </div>
        {c.prix_ttc !== null && (
          <div className="prix">
            <strong>{euros(c.prix_ttc)}</strong>
            {c.prix_date_releve && <small>releve le {c.prix_date_releve}</small>}
          </div>
        )}
      </header>

      {c.fixture && (
        <p className="alerte-fixture">
          Donnee de developpement : cette note, ce prix et cet assemblage n'ont pas
          ete releves sur une fiche technique de producteur.
        </p>
      )}

      <dl className="faits">
        {c.assemblage.length > 0 && (
          <>
            <dt>Assemblage</dt>
            <dd>{c.assemblage.map((a) => (a.pct === null ? a.cepage : `${a.cepage} ${a.pct}%`)).join(', ')}</dd>
          </>
        )}
        {c.degre !== null && (<><dt>Degre</dt><dd>{c.degre} %</dd></>)}
        {c.elevage && (<><dt>Elevage</dt><dd>{c.elevage}</dd></>)}
      </dl>

      {c.niveau === 'cuvee' && c.note_degustation ? (
        <blockquote className="note">
          <p>« {c.note_degustation} »</p>
          <footer>
            {c.note_tronquee && <span className="tronquee">extrait · </span>}
            <a href={c.note_source?.url} target="_blank" rel="noreferrer noopener">
              {c.note_source?.label}
            </a>
            {c.note_source && <span className="date"> · releve le {c.note_source.date_releve}</span>}
          </footer>
        </blockquote>
      ) : c.profil_appellation ? (
        <blockquote className="note note-appellation">
          <p className="avertissement-niveau">
            Aucune fiche technique indexee pour cette cuvee. Ce qui suit decrit
            l'<strong>appellation</strong>, pas ce vin.
          </p>
          <p>{c.profil_appellation.texte}</p>
          <footer>
            <a href={c.profil_appellation.source.url} target="_blank" rel="noreferrer noopener">
              {c.profil_appellation.source.label}
            </a>
            {c.profil_appellation.section && <span className="date"> · {c.profil_appellation.section}</span>}
          </footer>
        </blockquote>
      ) : null}

      {c.fiche_url && (
        <p className="lien-fiche">
          <a href={c.fiche_url} target="_blank" rel="noreferrer noopener">Fiche du domaine</a>
        </p>
      )}
    </article>
  );
}
