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
- **Vide** — « un rouge à base de cinsaut » → le cinsaut est autorisé par
  l'encépagement de l'AOC, donc aucun refus n'est dû, mais aucune cuvée du
  catalogue n'en contient. Réponse vide assumée, distincte du refus. Les trois
  états tiennent sur le même axe : chardonnay refuse, cinsaut est vide, syrah
  répond.
- **Donnée manquante** — « autour de 20 € » quand aucun prix n'est relevé →
  « je ne peux pas répondre sur ce critère ». « Aucun vin sous 20 € » et « je
  n'ai le prix d'aucun vin » sont deux réponses différentes, et confondre la
  seconde avec la première est une affirmation sans fondement.
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

### Ce que le passage aux données réelles a révélé

Le corpus de fixtures validait le moteur sur un vocabulaire que j'avais écrit
moi-même. Quinze fiches de producteurs ont fait tomber trois défauts que cinq
fiches inventées ne pouvaient pas montrer. C'est l'argument pour livrer tôt sur
de la vraie donnée, pas pour polir un moteur sur un corpus de laboratoire.

**Le plafond d'élargissement était décoratif.** L'échelle montait par paliers de
25 % et abandonnait dès que le palier suivant dépassait le plafond de +50 %, au
lieu de s'y caler : sur un budget de 12 €, elle s'arrêtait à 15 € et répondait
« rien trouvé » alors que deux cuvées étaient à 16 € et que le plafond annoncé
était 18 €. Invisible avec les fixtures, dont la moins chère tombait dans le
premier palier. Un plafond qu'on ne peut pas atteindre ment sur ce que le
système a essayé.

**Le lexique ratait les nominalisations.** `racine()` réduit `souple` à `soupl`
mais `souplesse` à `soupless`, `rondeur` à `rondeur`, `charpentée` à
`charpente` alors que la clé est `charpent`. Résultat : une cuvée dont la note
dit littéralement « alliant gourmandise, **souplesse** et puissance » sortait
en **négatif** sur une demande de vin souple. Les fiches inventées disaient
« souple » et « tanins fondus », jamais « souplesse » — la morphologie réelle
est plus riche que celle qu'on produit en écrivant ses propres données.

Le correctif suit le design existant, qui énumère les formes de surface dans
`FAMILLES` (`epice` **et** `epicee` y sont déjà) plutôt que de complexifier le
stemmer : toucher à `racine()` aurait cassé des clés en place. Les formes
ajoutées sont toutes des flexions de mots **déjà** dans leur famille, donc
aucun jugement œnologique nouveau. L'écart de classement est passé de 0,56 à
0,64.

**Le mot qui donne la couleur resservait de descripteur.** `racine('rose')`
vaut `ros`, et la rose est une fleur du lexique floral : « un rosé » repartait
avec un descripteur `floral` que personne n'avait demandé. Sans rosé au
catalogue, ça ne se voyait pas.

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

### Une seule règle, tenue aux deux bouts

Au jalon 5, toute note extraite d'un PDF doit se retrouver **littéralement**
dans sa couche texte. La même règle s'applique en sortie : tout segment entre
guillemets dans la réponse du modèle doit être une sous-chaîne littérale d'un
passage fourni (`src/llm/controle-sortie.ts`). Sinon, la réponse est remplacée
par le gabarit, qui ne peut rien inventer.

C'est exact, sans faux positif, et ça attrape la reformulation comme
l'attribution croisée — deux choses qu'un filtre de vocabulaire laisse passer.
Hors guillemets, un contrôle par familles de descripteurs complète, **scopé par
référence** : globalement, trois notes couvrant le lexique saturaient l'ensemble
autorisé et le contrôle devenait incapable de rien rejeter.

**Ce contrôle sert le contrat « aucune invention », pas la loi Evin.** Le lexique
ne contient aucun mot d'ambiance : « une soirée d'été entre amis » passe. À dire
plutôt qu'à masquer.

### Le corpus est le vrai vecteur d'injection

La demande de l'utilisateur n'atteint jamais le prompt de formulation. Le texte
tiers, si : au jalon 5, les notes viendront de PDF téléchargés sur des sites
qu'on ne contrôle pas. Trois défenses, par ordre de rapport qualité/prix :

1. **Réduire la surface.** On transmet le passage retenu, pas la fiche entière.
   Une injection qui doit tenir en une phrase, passer pour une note de
   dégustation et survivre à la sélection de passage est difficile à écrire.
2. **Vérifier les citations** (ci-dessus).
3. **Quarantaine à l'ingestion** (`src/ingest/quarantaine.ts`). Une note
   contenant ce qui ressemble à une instruction est signalée pour relecture
   humaine, pas rejetée. C'est le seul filtre heuristique du projet, et il est
   placé là où se tromper est bon marché : l'ingestion est hors ligne, rare et
   supervisée. Un faux positif y coûte trente secondes ; en ligne il coûterait
   une réponse dégradée.

**La garantie reste architecturale en provider `local` et contrôlée en provider
`anthropic`.** Pour une démo dont l'argument est « le moteur ne dépend pas de la
bonne volonté du modèle », le gabarit *est* le produit ; le LLM est une couche
de confort dont la sortie est vérifiée et qui retombe sur le gabarit au moindre
doute. C'est défendable et vérifiable en direct.

L'interface porte la mention sanitaire. Un interstitiel d'âge reste à ajouter si
la démo devient publique : ce n'est pas de l'authentification, c'est vingt lignes.

---

## État des données

**Le catalogue est réel.** 17 cuvées de 7 domaines, relevées le 16 septembre
2026 sur les pages publiées par les producteurs eux-mêmes, chacune sous une
source `page_domaine` portant son URL et sa date. Le référentiel compte les
**74 producteurs** de l'appellation, relevés sur l'annuaire du syndicat. Le
détail du relevé, y compris ce qui a été écarté et pourquoi, est dans
`ingestion/RELEVE-2026-09-16.md`.

La démo tourne donc **`PSL_AUTORISER_FIXTURES=0`**, ce qui n'était pas le cas
avant : sans données réelles, le catalogue entier était un calque de
développement.

### Ce qui reste du calque

Deux cuvées du Château de Lancyre. Le site alterne 200 et échecs de poignée de
main TLS, et sa boutique est un Wix rendu en JavaScript. Elles gardent leurs
valeurs de développement sous une source `fixture_dev`, masquées champ par
champ quand le flag est à 0 : la cuvée reste visible, sa description retombe
sur le profil d'appellation, et l'interface l'annonce.

Le masquage porte sur les colonnes, pas seulement sur l'affichage : un prix
masqué vaut `NULL` et cesse d'être retenu par un filtre de budget. Filtrer sur
une valeur qu'on refuse d'afficher serait pire que de l'exclure. `/api/sante`
et `/api/catalogue` appliquent le même prédicat.

Les cas de masquage de `tests/recherche.test.ts` se **désactivent visiblement**
(`it.skip`) le jour où `db/seed/cuvees.fixtures/` disparaît, plutôt que de
passer en silence sur un ensemble vide.

### Trois limites à énoncer avant de montrer la démo

**Deux paires de cuvées portent une note identique.** Dame Jeanne rouge 2022 et
2023 d'un côté, les deux Moja Negra de l'autre. Vérification faite, les pages
citées sont distinctes et portent réellement le même texte : les domaines
réutilisent leur propre copie d'un produit au suivant. La donnée est donc
honnête et sourcée, et c'est pour ça qu'elle n'est pas « corrigée ». Mais elle
a deux conséquences : leurs vecteurs sont identiques, donc rien ne les
départage, et sur trois résultats elles peuvent occuper deux places en
paraissant un bug. Un écran qui affiche deux vins différents sous la même
description perd la confiance qu'il cherche à établir ; dédupliquer sur la note
est une décision produit, pas un correctif.

**Le degré manque presque partout.** 5 cuvées sur 17. C'est le champ le plus
mal servi par les sites marchands, et celui qui viendrait des fiches techniques.

**Un millésime à vérifier.** Dame Jeanne rosé est enregistré en 2025, l'URL de
la page citée porte `...rose-2024...`. Slug périmé ou millésime mal relevé :
impossible de trancher sans rouvrir la page. Signalé plutôt que corrigé au
jugé, puisque c'est précisément la traçabilité qui est en jeu.

### Ce qui manque encore

Les **fiches techniques PDF**. La Bergerie du Capucin en annonce quatre en
téléchargement ; son serveur les sert avec `Content-Length: 0`. Le banc de
mesure du jalon 5 tourne donc toujours sur trois PDF fabriqués ici, et **son
taux de 3 % ne vaut rien** : mesurer un extracteur sur des fiches qu'on a
soi-même produites est circulaire. Il faut demander les fiches aux domaines ou
les récupérer au caveau.

---

## Jalons

| | | |
|---|---|---|
| 1 | Socle données | fait, sur corpus réel (17 cuvées, 74 producteurs) |
| 2 | Recherche hybride sans LLM | fait |
| 3 | Couche LLM, deux appels | provider Anthropic câblé, non exécuté faute de clé dans l'environnement |
| 4 | Interface | fait |
| 5 | Ingestion PDF automatisée | extracteur et banc de mesure faits, mesurés sur trois PDF fabriqués ici |

Le jalon 5 vit dans `ingestion/` (voir son README). Le contrat entre les deux
langages est posé : zod est la source de vérité unique, `npm run schema:export`
en produit le JSON Schema commité dans `db/schema/`, et `extraire.py` valide sa
sortie contre lui avant d'écrire. `tests/schema-export.test.ts` échoue si le
fichier commité n'est plus à jour.

Règle à tenir : le périmètre de Python s'arrête à « PDF → JSON ». Dès qu'il
touche la base, les embeddings ou l'API, ce sont deux toolchains à maintenir pour
une personne seule.

Garde-fou : toute note extraite doit se retrouver **littéralement** dans la
couche texte du PDF, vérifié par comparaison de chaînes. C'est le seul endroit
du pipeline où une hallucination passerait inaperçue.

**Le chiffre du banc de mesure ne vaut rien pour l'instant.** Les trois fiches de
test ont été fabriquées ici, donc mesurer l'extracteur dessus est circulaire. Le
banc est le livrable ; le taux ne sera lisible que sur de vraies fiches relues à
la main.
