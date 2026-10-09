import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCatalog, search } from './api.ts';
import { ResultCard } from './components/ResultCard.tsx';
import {
  PairingsBanner, DegradedBanner, RelaxationBanner, UndecidableBanner, RefusalBanner,
} from './components/Banners.tsx';
import { FilterPanel } from './components/FilterPanel.tsx';
import type { Catalog, Filters, SearchResponse } from './types.ts';

const EXAMPLES = [
  'un rouge pas trop tannique pour un gigot, autour de 20 euros',
  'un vin blanc du Pic Saint-Loup',
  'un rouge bio en dessous de 12 euros',
  'quelque chose de charpente, a base de mourvedre',
  'un rose pour l apero',
];

const RANKING_LABELS: Record<string, string> = {
  vector: 'vectoriel',
  lexicographic: 'lexicographique',
};

export function App() {
  const [message, setMessage] = useState('');
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [filters, setFilters] = useState<Filters | null>(null);
  const [modified, setModified] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { loadCatalog().then(setCatalog).catch(() => {}); }, []);

  const run = useCallback(async (text: string, forcedFilters?: Filters) => {
    setLoading(true);
    setError(null);
    try {
      const r = await search(text, forcedFilters);
      setResponse(r);
      if (r.search) {
        setFilters(r.search.appliedFilters);
        setModified(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim()) void run(message.trim());
  };

  return (
    <div className="app">
      <header className="page-header">
        <div>
          <h1>Pic Saint-Loup</h1>
          <p>
            Recherche par description, sur les vins des domaines du Pic Saint-Loup :
            l'AOP, et les appellations voisines sous lesquelles ils vendent leurs autres cuvees.
          </p>
        </div>
        {response?.fixtures_enabled && (
          <p className="global-warning">
            Mode developpement : notes, prix et assemblages non sourcés.
          </p>
        )}
      </header>

      <main className="layout">
        <section className="conversation">
          <form onSubmit={submit}>
            <textarea
              ref={input}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
              }}
              placeholder="Decrivez ce que vous cherchez…"
              rows={3}
              maxLength={400}
            />
            <div className="submit-bar">
              <span className="counter">{message.length}/400</span>
              <button type="submit" disabled={loading || !message.trim()}>
                {loading ? 'Recherche…' : 'Chercher'}
              </button>
            </div>
          </form>

          <div className="examples">
            {EXAMPLES.map((ex) => (
              <button key={ex} className="example" onClick={() => { setMessage(ex); void run(ex); }}>
                {ex}
              </button>
            ))}
          </div>

          {error && <div className="banner banner-error">{error}</div>}

          {response && (
            <div className="answer">
              {response.degraded && <DegradedBanner reason={response.degraded_reason ?? null} />}
              {response.search && <RefusalBanner search={response.search} />}
              {response.search && <UndecidableBanner search={response.search} />}
              {response.search && <RelaxationBanner search={response.search} />}

              {/* The refusal banner already carries the message and its source:
                  showing the raw text below it would say it twice. */}
              {response.search?.status !== 'refused' && (
                <p className="answer-text">{response.text}</p>
              )}

              {response.search?.status === 'empty' &&
                response.search.undecidableFilters.length === 0 && (
                <div className="banner banner-empty">
                  <strong>Aucune reference.</strong> Le catalogue compte{' '}
                  {response.search.catalogSize} cuvee(s) pour cette designation et
                  cette couleur. Rien n'est propose par defaut.
                </div>
              )}

              <div className="results">
                {response.search?.results.map((w, i) => (
                  <ResultCard key={w.id} wine={w} rank={i + 1} labels={catalog?.labels} />
                ))}
              </div>

              {response.search && <PairingsBanner search={response.search} />}

              {response.search && response.search.results.length > 0 && (
                <p className="meta">
                  Classement {RANKING_LABELS[response.search.ranking] ?? response.search.ranking}
                  {response.latency_ms !== undefined && ` · ${response.latency_ms} ms`}
                </p>
              )}
            </div>
          )}
        </section>

        {filters && (
          <FilterPanel
            filters={filters}
            catalog={catalog}
            onChange={(f) => { setFilters(f); setModified(true); }}
            onRerun={() => void run(message, filters)}
            modified={modified}
          />
        )}
      </main>

      <footer className="page-footer">
        <p className="health-notice">L'abus d'alcool est dangereux pour la sante. A consommer avec moderation.</p>
        <p>
          Les descriptions proviennent des fiches techniques des domaines et du cahier
          des charges INAO de l'AOP Pic Saint-Loup. Le badge AOP signale une appellation
          d'origine protegee. Chaque element affiche porte sa source.
          Aucune note de degustation n'est generee.
        </p>
      </footer>
    </div>
  );
}
