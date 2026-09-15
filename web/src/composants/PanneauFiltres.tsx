import type { Catalogue, Filtres } from '../types.ts';

interface Props {
  filtres: Filtres;
  catalogue: Catalogue | null;
  onChange: (f: Filtres) => void;
  onRelancer: () => void;
  modifie: boolean;
}

const LIBELLES: Record<string, string> = {
  appellation: 'Appellation', couleur: 'Couleur', prix_min: 'Prix minimum',
  prix_max: 'Budget maximum', millesime_min: 'Millesime le plus ancien',
  millesime_max: 'Millesime le plus recent', bio: 'Bio', plat: 'Plat',
  cepages_inclus: 'Cepages souhaites', cepages_exclus: 'Cepages exclus',
  descripteurs: 'Descripteurs', descripteurs_exclus: 'Descripteurs refuses',
};

/**
 * Le panneau de filtres n'est pas un resume: c'est ce que le systeme a
 * REELLEMENT applique, et c'est modifiable. Corriger un filtre relance la
 * recherche en court-circuitant l'interpretation du modele.
 */
export function PanneauFiltres({ filtres, catalogue, onChange, onRelancer, modifie }: Props) {
  const set = <K extends keyof Filtres>(cle: K, valeur: Filtres[K]) =>
    onChange({ ...filtres, [cle]: valeur });

  const nombre = (v: string): number | null => (v === '' ? null : Number(v));

  return (
    <aside className="panneau">
      <div className="panneau-entete">
        <h2>Filtres appliques</h2>
        <p className="aide">
          Ce que le systeme a compris de votre demande. Modifiable : une correction
          relance la recherche sans repasser par l'interpretation.
        </p>
      </div>

      <label className="champ">
        <span>{LIBELLES.couleur}</span>
        <select value={filtres.couleur ?? ''} onChange={(e) => set('couleur', e.target.value || null)}>
          <option value="">indifferent</option>
          {(catalogue?.couleurs ?? ['rouge', 'rose', 'blanc']).map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
          {/* Le blanc reste proposable: c'est ainsi qu'on demontre le refus. */}
          {!catalogue?.couleurs.includes('blanc') && <option value="blanc">blanc</option>}
        </select>
      </label>

      <label className="champ">
        <span>{LIBELLES.appellation}</span>
        <select value={filtres.appellation ?? ''} onChange={(e) => set('appellation', e.target.value || null)}>
          <option value="">indifferent</option>
          {(catalogue?.appellations ?? []).map((a) => (
            <option key={a.id} value={a.id}>{a.nom}</option>
          ))}
        </select>
      </label>

      <div className="champ-double">
        <label className="champ">
          <span>{LIBELLES.prix_min}</span>
          <input type="number" min={0} step={1} value={filtres.prix_min ?? ''}
                 onChange={(e) => set('prix_min', nombre(e.target.value))} placeholder="—" />
        </label>
        <label className="champ">
          <span>{LIBELLES.prix_max}</span>
          <input type="number" min={0} step={1} value={filtres.prix_max ?? ''}
                 onChange={(e) => set('prix_max', nombre(e.target.value))} placeholder="—" />
        </label>
      </div>

      <div className="champ-double">
        <label className="champ">
          <span>Millesime min.</span>
          <input type="number" min={1900} max={2100} value={filtres.millesime_min ?? ''}
                 onChange={(e) => set('millesime_min', nombre(e.target.value))} placeholder="—" />
        </label>
        <label className="champ">
          <span>Millesime max.</span>
          <input type="number" min={1900} max={2100} value={filtres.millesime_max ?? ''}
                 onChange={(e) => set('millesime_max', nombre(e.target.value))} placeholder="—" />
        </label>
      </div>

      <label className="champ champ-inline">
        <input type="checkbox" checked={filtres.bio === true}
               onChange={(e) => set('bio', e.target.checked ? true : null)} />
        <span>Agriculture biologique uniquement</span>
      </label>

      <ListeJetons titre={LIBELLES.cepages_inclus!} valeurs={filtres.cepages_inclus}
                   onRetirer={(v) => set('cepages_inclus', filtres.cepages_inclus.filter((x) => x !== v))} />
      <ListeJetons titre={LIBELLES.cepages_exclus!} valeurs={filtres.cepages_exclus} negatif
                   onRetirer={(v) => set('cepages_exclus', filtres.cepages_exclus.filter((x) => x !== v))} />
      <ListeJetons titre={LIBELLES.descripteurs!} valeurs={filtres.descripteurs}
                   onRetirer={(v) => set('descripteurs', filtres.descripteurs.filter((x) => x !== v))} />
      <ListeJetons titre={LIBELLES.descripteurs_exclus!} valeurs={filtres.descripteurs_exclus} negatif
                   onRetirer={(v) => set('descripteurs_exclus', filtres.descripteurs_exclus.filter((x) => x !== v))} />

      {filtres.plat && (
        <ListeJetons titre={LIBELLES.plat!} valeurs={[filtres.plat]} onRetirer={() => set('plat', null)} />
      )}

      <button className="bouton-relancer" onClick={onRelancer} disabled={!modifie}>
        {modifie ? 'Relancer avec ces filtres' : 'Filtres a jour'}
      </button>

      <p className="aide aide-vectoriel">
        Les descripteurs servent uniquement au classement. Ils ne sont jamais
        repris dans le texte de la reponse.
      </p>
    </aside>
  );
}

function ListeJetons({ titre, valeurs, onRetirer, negatif }: {
  titre: string; valeurs: string[]; onRetirer: (v: string) => void; negatif?: boolean;
}) {
  if (valeurs.length === 0) return null;
  return (
    <div className="champ">
      <span>{titre}</span>
      <div className="jetons">
        {valeurs.map((v) => (
          <button key={v} className={negatif ? 'jeton jeton-negatif' : 'jeton'}
                  onClick={() => onRetirer(v)} title="Retirer ce filtre">
            {negatif ? '− ' : ''}{v} <span aria-hidden>×</span>
          </button>
        ))}
      </div>
    </div>
  );
}
