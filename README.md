# Pic Saint-Loup

Moteur de recherche conversationnel sur catalogue. Un visiteur décrit un besoin
en langage naturel, le système traduit la demande en filtres explicites,
interroge le catalogue, et répond en citant ses sources.

Le sujet est le vin. **Le produit est le moteur.** La spécificité du domaine vit
dans `src/config/` et dans les données ; le moteur de recherche ne connaît ni
« couleur » ni « millésime ».

---

## Démarrer

```bash
# 1. Une base Postgres 16 avec pgvector
docker compose up -d
#    ou, sans Docker, sur une machine où postgresql-16 est installé :
#    bash scripts/bootstrap-postgres-local.sh

# 2. Configuration
cp .env.example .env

# 3. Schéma, données, vecteurs
npm install
npm run setup

# 4. API + interface
npm run api          # http://localhost:3000
npm run web:dev      # http://localhost:5173 (dev, proxy vers l'API)
```

Sans clé API, tout fonctionne : les providers `local` d'embedding et de LLM sont
déterministes et hors ligne. Voir « Providers » plus bas.

```bash
npm run demo -- "un rouge pas trop tannique pour un gigot, autour de 20 euros"
npm test
```

---

## Le contrat de comportement

C'est le cœur du projet, et il prime sur la qualité perçue des réponses. La
particularité de cette implémentation : **les garanties sont posées en
contraintes Postgres, pas en consignes de prompt.** Elles tiennent donc même si
le modèle déraille, et elles sont démontrables sans lui.

| Garantie | Où elle est appliquée |
|---|---|
| Aucune note de dégustation sans source citable | `CHECK note_exige_source` |
| Aucun prix sans sa date de relevé | `CHECK prix_exige_date` |
| Un Pic Saint-Loup blanc est impossible | FK composite `(appellation_id, couleur)` → `appellation_couleurs` |
| Le niveau de description ne peut pas mentir | `CHECK niveau_coherent` |
| Un accord mets-vins ne peut pas devenir une donnée source | `CHECK statut = 'derive'` |

Le refus d'un blanc en Pic Saint-Loup est **un résultat de requête**, pas une
consigne : `tests/recherche.test.ts` le vérifie sans aucun appel LLM.

Quatre comportements se voient à l'écran :

- **Refus de couverture** — « un vin blanc du Pic Saint-Loup » → refus explicite
  citant le cahier des charges INAO. Aucun blanc approchant n'est proposé.
- **Refus d'encépagement** — « avez-vous du chardonnay ? » → refus citant les
  cépages que l'appellation autorise. Les cépages hors appellation sont
  reconnus **délibérément** (`CEPAGES_HORS_APPELLATION`) : sans ça la contrainte
  s'évaporait et le système répondait trois rouges.
- **Vide** — « un rosé » → l'AOC autorise le rosé, mais aucune cuvée rosée n'est
  indexée. Réponse vide assumée, distincte du refus.
- **Élargissement** — « moins de 12 euros » → rien sous 12 €, le budget est
  relâché par paliers de 25 %, plafonné à +50 %, et **annoncé**. L'appellation
  n'est jamais relâchée en silence.

---

## Architecture

```
message ──► appel LLM 1 ──► filtres validés (schéma strict)
                              │
                              ├─► contraintes dures  ──► WHERE SQL
                              └─► partie floue       ──► vecteur de requête
                                                          │
                            requête SQL exécutée par le CODE, jamais par le modèle
                                                          │
                              lignes ──► appel LLM 2 ──► texte
```

Deux appels déterministes, pas de boucle autonome, pas de framework
d'orchestration. Le vectoriel ne sert qu'à la partie floue (« souple »,
« frais ») ; prix, millésime et appellation sont des colonnes et des `WHERE`.

### Séparation des niveaux

Le seed proposait `embedding_source = note du producteur + profil d'appellation`.
**C'est écarté volontairement.** Concaténer le profil AOC dans chaque vecteur rend
toutes les cuvées de l'appellation quasi colinéaires : le texte commun domine le
cosinus et le classement s'effondre.

- note du producteur présente → elle est embeddée **seule**, `embedding_niveau = 'cuvee'` ;
- absente → aucun vecteur n'est fabriqué, `embedding_niveau = 'appellation'`, la
  recherche retombe sur le profil AOC **et l'annonce** dans l'interface.

### Réutilisabilité

`src/config/domaine.ts` déclare les filtres, leur colonne, leur opérateur, leur
mode de relâchement et la règle de couverture. `src/config/lexique.ts` porte le
vocabulaire. Changer de métier = réécrire ces deux fichiers. Pas de couche de
plugins, pas de modèle d'entité générique : le brief interdit explicitement
d'anticiper un second client qui n'existe pas.

---

## Providers

| Variable | `local` (défaut) | Alternative |
|---|---|---|
| `PSL_EMBEDDING_PROVIDER` | sac de mots + lexique, hors ligne, déterministe | `openai`, `mistral` |
| `PSL_LLM_PROVIDER` | parseur par règles + formulation par gabarit | `anthropic` |

Le provider local n'est pas qu'un bouche-trou : il démontre que le contrat de
comportement tient **sans modèle**. Aucun texte n'est généré, donc rien ne peut
être inventé ; refus et élargissements sortent de requêtes. Le LLM n'améliore
ensuite que la formulation. C'est l'argument à montrer à un prospect : le moteur
ne dépend pas de la bonne volonté du modèle.

Le provider local ignore la négation par construction (un sac de mots ne nie
pas). Elle est donc résolue **en amont**, au parsing : « pas trop tannique »
produit `descripteurs: ['souple']` **et** `descripteurs_exclus: ['tannique']`, et
le vecteur de requête vaut `normalise(v(souhaité) − 0,7 · v(refusé))`.

### Vecteurs périmés

Modifier `src/config/lexique.ts` change la vectorisation des notes sans toucher
aux vecteurs déjà stockés : le classement continuerait de fonctionner, sur des
données périmées, sans aucun signal. La table `embedding_etat` stocke une
empreinte de la configuration ; en cas d'écart, le moteur **refuse** de classer
au vectoriel et repasse au prix. Relancer `npm run db:embed`.

---

## Garde-fous de dépense

Une démo publique sans garde-fou est le seul vrai risque financier du projet.
Trois limites, vérifiées **avant** tout appel au modèle (`src/api/gardefous.ts`) :

- `PSL_MAX_LONGUEUR_MESSAGE` — 400 caractères ;
- `PSL_RATE_LIMIT_PAR_IP_PAR_HEURE` — 20, sur un HMAC de l'IP, jamais l'IP ;
- `PSL_PLAFOND_EUR_PAR_JOUR` — coupe le service pour la journée.

Les compteurs vivent dans la table `recherches`, qui sert aussi de journal de
démo : ce que le système a compris, ce qu'il a relâché, ce qu'il a refusé.

---

## Loi Evin

La communication sur les boissons alcoolisées est encadrée : les références
objectives sont admises, l'évocation et l'incitation ne le sont pas.

Quatre points de fuite ont été identifiés et traités :

1. Le champ `ancrage` du seed (« agneau de garrigue », « sans écraser ») est de
   la prose éditoriale non sourcée, au registre proscrit. **Il n'est pas ingéré.**
2. `accords_producteur` recopie de la prose commerciale des domaines. Il est
   stocké mais n'alimente pas la formulation.
3. Le prompt de formulation ne cite que des champs nommés et ne reformule rien.
4. **Le message de l'utilisateur lui-même.** « Décris-moi ce vin comme une soirée
   d'été » injecte le registre interdit. C'est le point le plus facile à rater :
   le type `EntreeFormulation` (`src/llm/index.ts`) ne contient ni le message ni
   les descripteurs, et `entreeFormulation()` construit l'objet **champ par
   champ**. Un spread aurait laissé `filtresDemandes` physiquement présent dans
   l'objet remis au modèle : TypeScript ne vérifie pas les propriétés en trop
   sur un spread, donc la barrière n'aurait existé qu'à la lecture.

Deux points restent ouverts, et il faut les dire :

- **Le corpus est un vecteur d'injection, pas seulement l'utilisateur.** Une
  note de fiche technique contenant une consigne part brute au modèle. Seule la
  règle 7 du prompt s'y oppose.
- **La garantie est architecturale en provider `local`, contrôlée en provider
  `anthropic`.** `descripteursInventes()` bascule sur le gabarit si la réponse
  du modèle introduit une famille de descripteurs absente des notes fournies.
  C'est un filet, pas une preuve : à énoncer honnêtement en clientèle.

L'interface porte la mention sanitaire. Un interstitiel d'âge reste à ajouter si
la démo devient publique : ce n'est pas de l'authentification, c'est vingt lignes.

---

## État des données

**L'egress réseau de l'environnement de développement bloque les sites des
domaines et du syndicat.** Aucune fiche technique n'a pu être récupérée, et
aucune note de dégustation n'a été tirée d'un résumé de moteur de recherche :
les résumés obtenus se contredisaient entre eux sur l'assemblage d'un même vin.

Conséquence, assumée et visible :

- `db/seed/cuvees/` — ce qui a pu être établi (domaine, cuvée, appellation,
  couleur, millésime). Tout le reste est `null`.
- `db/seed/cuvees.fixtures/` — un **calque** qui remplit note, prix, degré et
  assemblage avec des valeurs de développement, sous une source de type
  `fixture_dev`.

Le calque n'est appliqué que si `PSL_AUTORISER_FIXTURES=1`. **Le défaut du code
est `0`.**

Le verrou joue à l'ingestion **et** à la lecture, pour le cas où la base aurait
été peuplée avec le flag à 1 puis servie avec le flag à 0. À la lecture, on
masque les **champs** issus du calque, pas la ligne : la cuvée reste visible et
sa description retombe sur le profil d'appellation, en l'annonçant. Exclure la
ligne faisait répondre « le catalogue ne contient aucune cuvée » sur un
catalogue de cinq, pendant que `/api/catalogue` annonçait les mêmes.

Le masquage porte sur les colonnes, pas seulement sur l'affichage : un prix
masqué vaut `NULL` et cesse d'être retenu par un filtre de budget. Filtrer sur
une valeur qu'on refuse d'afficher serait pire que de l'exclure. `/api/sante` et
`/api/catalogue` appliquent le même prédicat, sans quoi le curseur de budget du
front affichait une fourchette construite sur des données de développement.

Pour passer en données réelles : remplir `db/seed/cuvees/*.json` depuis les
fiches techniques, supprimer le dossier `cuvees.fixtures/`, remettre la variable
à `0`.

---

## Jalons

| | | |
|---|---|---|
| 1 | Socle données | fait |
| 2 | Recherche hybride sans LLM | fait |
| 3 | Couche LLM, deux appels | provider Anthropic câblé, non exécuté faute de clé dans l'environnement |
| 4 | Interface | fait |
| 5 | Ingestion PDF automatisée | à faire, en Python |

Le jalon 5 est en Python (`pdfplumber`, OCR si les fiches sont des scans). Le
contrat entre les deux langages est posé : zod est la source de vérité unique,
`npm run schema:export` en produit le JSON Schema commité dans `db/schema/`, que
le script Python validera avant d'écrire. `tests/schema-export.test.ts` échoue si
le fichier commité n'est plus à jour.

Règle à tenir : le périmètre de Python s'arrête à « PDF → JSON ». Dès qu'il
touche la base, les embeddings ou l'API, ce sont deux toolchains à maintenir pour
une personne seule.

Garde-fou pour le jalon 5 : toute note extraite doit se retrouver
**littéralement** dans la couche texte du PDF, vérifié par comparaison de
chaînes. C'est le seul endroit du pipeline où une hallucination passerait
inaperçue.
