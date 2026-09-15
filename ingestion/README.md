# Jalon 5 — extraction des fiches techniques

Fiche technique PDF → JSON conforme à `db/schema/cuvee.schema.json`.

```bash
python3 -m venv .venv && .venv/bin/pip install -r ingestion/requirements.txt

.venv/bin/python ingestion/extraire.py ingestion/fiches/*.pdf --sortie ingestion/sortie
.venv/bin/python ingestion/mesure.py
```

## Pourquoi Python ici, et seulement ici

Le runtime est en TypeScript. Python n'intervient que sur l'extraction PDF,
où `pdfplumber` et l'OCR n'ont pas d'équivalent côté Node.

**Le périmètre s'arrête à « PDF → JSON ».** Ce script ne connaît ni Postgres,
ni les embeddings, ni l'API : il lit un fichier et en écrit un autre. Dès qu'il
touche à la base, le split devient deux toolchains à maintenir pour une seule
personne, et le coût dépasse le bénéfice.

Le contrat entre les deux langages est un fichier : `db/schema/cuvee.schema.json`,
généré depuis zod par `npm run schema:export` et commité. `extraire.py` valide
sa sortie contre lui avant d'écrire. Un schéma modifié sans réexport fait
échouer `tests/schema-export.test.ts`.

## Le garde-fou qui compte

`Extracteur.verbatim()` refuse toute valeur textuelle absente de la couche texte
du PDF. Un champ rejeté vaut `null` : **on préfère un trou à une invention.**

C'est le seul endroit du pipeline où une hallucination passerait inaperçue. Tout
le reste du système travaille sur des données déjà en base, protégées par les
contraintes Postgres. Ici, on fabrique la donnée — et le jour où l'extraction
passera par un modèle vision, c'est cette fonction, et elle seule, qui empêchera
une note de dégustation d'être écrite plutôt que lue.

## Le taux d'erreur est le livrable

`mesure.py` compare la sortie à un jeu relu à la main (`attendu/`) et distingue
quatre issues par champ :

| | |
|---|---|
| `exact` | la valeur extraite est celle relevée à la main |
| `divergent` | une valeur a été extraite, mais fausse |
| `manquant` | rien n'a été extrait alors qu'il y avait quelque chose |
| `superflu` | quelque chose a été extrait alors qu'il n'y avait rien |

`divergent` est le cas grave et il est compté à part : **une donnée fausse coûte
plus cher qu'une donnée absente.** Un champ vide part en relecture ; un champ
faux passe pour correct.

C'est cette sortie qu'on montre au client, pas une qualité supposée.

## Ce que l'extracteur ne fait pas, volontairement

La fiche `domaine-c-prose` n'écrit jamais la couleur du vin. Un relecteur humain
la déduit de « robe grenat », « mûre », « tanins fermes ». L'extracteur ne le
fait pas, et c'est **compté comme une erreur, pas excusé**.

Déduire aurait produit un champ qui a l'air correct et que personne ne
revérifie. Ne pas déduire produit un trou, qui remonte dans le rapport et part
en relecture. La déduction, si elle est souhaitée, est une étape de revue
séparée et tracée comme telle — pas un effet de bord de l'extraction.

## Le corpus de test

`fiches/` contient trois PDF fabriqués par `fabriquer_fiches_test.mjs`
(Chromium en impression PDF), avec des mises en page volontairement
différentes : tableau, lignes étiquetées, prose sans intitulés normalisés.
C'est la réalité d'un corpus de soixante domaines : chacun a son gabarit.

**Limite à énoncer avant de montrer un chiffre :** ces fiches ont été
fabriquées ici, donc mesurer l'extracteur dessus est en partie circulaire. Le
taux obtenu sur ce corpus n'est pas prédictif du réel. Le banc de mesure est le
livrable ; le chiffre ne vaudra que sur de vraies fiches, relues à la main.

L'egress réseau de l'environnement de développement bloque les sites des
domaines : aucune fiche réelle n'a pu être récupérée.

## Étapes suivantes

1. Parser l'annuaire du syndicat — une page unique et structurée, un seul point
   d'entrée, pas soixante sites à crawler en aveugle.
2. Localiser les PDF sur chaque site (`/nos-vins`, `/la-cave`, espace pro).
   Respecter `robots.txt`, limiter la cadence, user-agent identifiable.
3. Relire le premier lot à la main, le figer dans `attendu/`, et mesurer.
4. Si les fiches sont des scans : OCR en amont, le reste ne bouge pas. Si
   l'extraction par règles plafonne, passer à un modèle vision — `verbatim()`
   reste la condition d'acceptation.
