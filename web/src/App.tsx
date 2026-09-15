import { useCallback, useEffect, useRef, useState } from 'react';
import { chargerCatalogue, rechercher } from './api.ts';
import { CarteResultat } from './composants/CarteResultat.tsx';
import {
  BandeauAccords, BandeauDegrade, BandeauElargissement, BandeauRefus,
} from './composants/Bandeaux.tsx';
import { PanneauFiltres } from './composants/PanneauFiltres.tsx';
import type { Catalogue, Filtres, ReponseRecherche } from './types.ts';

const EXEMPLES = [
  'un rouge pas trop tannique pour un gigot, autour de 20 euros',
  'un vin blanc du Pic Saint-Loup',
  'un rouge bio en dessous de 12 euros',
  'quelque chose de charpente, a base de mourvedre',
  'un rose pour l apero',
];

export function App() {
  const [message, setMessage] = useState('');
  const [reponse, setReponse] = useState<ReponseRecherche | null>(null);
  const [filtres, setFiltres] = useState<Filtres | null>(null);
  const [modifie, setModifie] = useState(false);
  const [chargement, setChargement] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const champ = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { chargerCatalogue().then(setCatalogue).catch(() => {}); }, []);

  const lancer = useCallback(async (texte: string, filtresImposes?: Filtres) => {
    setChargement(true);
    setErreur(null);
    try {
      const r = await rechercher(texte, filtresImposes);
      setReponse(r);
      if (r.recherche) {
        setFiltres(r.recherche.filtresAppliques);
        setModifie(false);
      }
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setChargement(false);
    }
  }, []);

  const soumettre = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim()) void lancer(message.trim());
  };

  return (
    <div className="app">
      <header className="entete">
        <div>
          <h1>Pic Saint-Loup</h1>
          <p>Recherche par description, sur le catalogue des domaines de l'appellation.</p>
        </div>
        {reponse?.fixtures_actives && (
          <p className="alerte-globale">
            Mode developpement : notes, prix et assemblages non sourcés.
          </p>
        )}
      </header>

      <main className="grille">
        <section className="conversation">
          <form onSubmit={soumettre}>
            <textarea
              ref={champ}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) soumettre(e);
              }}
              placeholder="Decrivez ce que vous cherchez…"
              rows={3}
              maxLength={400}
            />
            <div className="barre-envoi">
              <span className="compteur">{message.length}/400</span>
              <button type="submit" disabled={chargement || !message.trim()}>
                {chargement ? 'Recherche…' : 'Chercher'}
              </button>
            </div>
          </form>

          <div className="exemples">
            {EXEMPLES.map((ex) => (
              <button key={ex} className="exemple" onClick={() => { setMessage(ex); void lancer(ex); }}>
                {ex}
              </button>
            ))}
          </div>

          {erreur && <div className="bandeau bandeau-erreur">{erreur}</div>}

          {reponse && (
            <div className="reponse">
              {reponse.degrade && <BandeauDegrade raison={reponse.raison_degrade ?? null} />}
              {reponse.recherche && <BandeauRefus recherche={reponse.recherche} />}
              {reponse.recherche && <BandeauElargissement recherche={reponse.recherche} />}

              {/* Le bandeau de refus porte deja le message et sa source:
                  reafficher le texte brut en dessous le dirait deux fois. */}
              {reponse.recherche?.statut !== 'refus_hors_catalogue' && (
                <p className="texte-reponse">{reponse.texte}</p>
              )}

              {reponse.recherche?.statut === 'vide' && (
                <div className="bandeau bandeau-vide">
                  <strong>Aucune reference.</strong> Le catalogue compte{' '}
                  {reponse.recherche.tailleCatalogue} cuvee(s) pour cette appellation et
                  cette couleur. Rien n'est propose par defaut.
                </div>
              )}

              <div className="resultats">
                {reponse.recherche?.resultats.map((c, i) => (
                  <CarteResultat key={c.id} c={c} rang={i + 1} />
                ))}
              </div>

              {reponse.recherche && <BandeauAccords recherche={reponse.recherche} />}

              {reponse.recherche && reponse.recherche.resultats.length > 0 && (
                <p className="meta">
                  Classement {reponse.recherche.classement}
                  {reponse.latence_ms !== undefined && ` · ${reponse.latence_ms} ms`}
                </p>
              )}
            </div>
          )}
        </section>

        {filtres && (
          <PanneauFiltres
            filtres={filtres}
            catalogue={catalogue}
            onChange={(f) => { setFiltres(f); setModifie(true); }}
            onRelancer={() => void lancer(message, filtres)}
            modifie={modifie}
          />
        )}
      </main>

      <footer className="pied">
        <p className="sanitaire">L'abus d'alcool est dangereux pour la sante. A consommer avec moderation.</p>
        <p>
          Les descriptions proviennent des fiches techniques des domaines et du cahier
          des charges INAO de l'appellation. Chaque element affiche porte sa source.
          Aucune note de degustation n'est generee.
        </p>
      </footer>
    </div>
  );
}
