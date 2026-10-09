import { designationLabel, labelOf, type Catalog, type Filters } from '../types.ts';

interface Props {
  filters: Filters;
  catalog: Catalog | null;
  onChange: (f: Filters) => void;
  onRerun: () => void;
  modified: boolean;
}

const FIELD_LABELS: Record<string, string> = {
  appellation: 'Appellation', color: 'Couleur', price_min: 'Prix minimum',
  price_max: 'Budget maximum', vintage_min: 'Millesime le plus ancien',
  vintage_max: 'Millesime le plus recent', organic: 'Bio', dish: 'Plat',
  grapes_included: 'Cepages souhaites', grapes_excluded: 'Cepages exclus',
  descriptors: 'Descripteurs', descriptors_excluded: 'Descripteurs refuses',
};

/**
 * The filter panel is not a summary: it is what the system ACTUALLY applied,
 * and it is editable. Correcting a filter reruns the search, bypassing the
 * model's interpretation.
 */
export function FilterPanel({ filters, catalog, onChange, onRerun, modified }: Props) {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    onChange({ ...filters, [key]: value });

  const number = (v: string): number | null => (v === '' ? null : Number(v));
  const labels = catalog?.labels;

  return (
    <aside className="panel">
      <div className="panel-header">
        <h2>Filtres appliques</h2>
        <p className="help">
          Ce que le systeme a compris de votre demande. Modifiable : une correction
          relance la recherche sans repasser par l'interpretation.
        </p>
      </div>

      <label className="field">
        <span>{FIELD_LABELS.color}</span>
        <select value={filters.color ?? ''} onChange={(e) => set('color', e.target.value || null)}>
          <option value="">indifferent</option>
          {(catalog?.colors ?? ['red', 'rose', 'white']).map((c) => (
            <option key={c} value={c}>{labelOf(labels?.colors, c)}</option>
          ))}
          {/* White stays selectable: that is how the refusal is demonstrated. */}
          {!catalog?.colors.includes('white') && (
            <option value="white">{labelOf(labels?.colors, 'white')}</option>
          )}
        </select>
      </label>

      <label className="field">
        <span>{FIELD_LABELS.appellation}</span>
        <select value={filters.appellation ?? ''} onChange={(e) => set('appellation', e.target.value || null)}>
          <option value="">indifferent</option>
          {(catalog?.appellations ?? []).map((a) => (
            <option key={a.id} value={a.id}>{designationLabel(a.name, a.tier)}</option>
          ))}
        </select>
      </label>

      <div className="field-pair">
        <label className="field">
          <span>{FIELD_LABELS.price_min}</span>
          <input type="number" min={0} step={1} value={filters.price_min ?? ''}
                 onChange={(e) => set('price_min', number(e.target.value))} placeholder="—" />
        </label>
        <label className="field">
          <span>{FIELD_LABELS.price_max}</span>
          <input type="number" min={0} step={1} value={filters.price_max ?? ''}
                 onChange={(e) => set('price_max', number(e.target.value))} placeholder="—" />
        </label>
      </div>

      <div className="field-pair">
        <label className="field">
          <span>Millesime min.</span>
          <input type="number" min={1900} max={2100} value={filters.vintage_min ?? ''}
                 onChange={(e) => set('vintage_min', number(e.target.value))} placeholder="—" />
        </label>
        <label className="field">
          <span>Millesime max.</span>
          <input type="number" min={1900} max={2100} value={filters.vintage_max ?? ''}
                 onChange={(e) => set('vintage_max', number(e.target.value))} placeholder="—" />
        </label>
      </div>

      <label className="field field-inline">
        <input type="checkbox" checked={filters.organic === true}
               onChange={(e) => set('organic', e.target.checked ? true : null)} />
        <span>Agriculture biologique uniquement</span>
      </label>

      <ChipList title={FIELD_LABELS.grapes_included!} values={filters.grapes_included}
                onRemove={(v) => set('grapes_included', filters.grapes_included.filter((x) => x !== v))} />
      <ChipList title={FIELD_LABELS.grapes_excluded!} values={filters.grapes_excluded} negative
                onRemove={(v) => set('grapes_excluded', filters.grapes_excluded.filter((x) => x !== v))} />
      <ChipList title={FIELD_LABELS.descriptors!} values={filters.descriptors} labels={labels?.descriptors}
                onRemove={(v) => set('descriptors', filters.descriptors.filter((x) => x !== v))} />
      <ChipList title={FIELD_LABELS.descriptors_excluded!} values={filters.descriptors_excluded} negative
                labels={labels?.descriptors}
                onRemove={(v) => set('descriptors_excluded', filters.descriptors_excluded.filter((x) => x !== v))} />

      {filters.dish && (
        <ChipList title={FIELD_LABELS.dish!} values={[filters.dish]} labels={labels?.dishes}
                  onRemove={() => set('dish', null)} />
      )}

      <button className="rerun-button" onClick={onRerun} disabled={!modified}>
        {modified ? 'Relancer avec ces filtres' : 'Filtres a jour'}
      </button>

      <p className="help help-vector">
        Les descripteurs servent uniquement au classement. Ils ne sont jamais
        repris dans le texte de la reponse.
      </p>
    </aside>
  );
}

function ChipList({ title, values, onRemove, negative, labels }: {
  title: string; values: string[]; onRemove: (v: string) => void; negative?: boolean;
  labels?: Record<string, string>;
}) {
  if (values.length === 0) return null;
  return (
    <div className="field">
      <span>{title}</span>
      <div className="chips">
        {values.map((v) => (
          <button key={v} className={negative ? 'chip chip-negative' : 'chip'}
                  onClick={() => onRemove(v)} title="Retirer ce filtre">
            {negative ? '− ' : ''}{labelOf(labels, v)} <span aria-hidden>×</span>
          </button>
        ))}
      </div>
    </div>
  );
}
