/**
 * Fabrique des fiches techniques de test au format PDF.
 *
 * Les vraies fiches des domaines n'etaient pas recuperables (egress bloque).
 * Ces trois-la ont des mises en page VOLONTAIREMENT differentes - tableau,
 * lignes etiquetees, prose avec intitules inhabituels - parce que c'est la
 * realite d'un corpus de soixante domaines: chacun a son gabarit.
 *
 * Limite a garder en tete: ces fiches sont fabriquees ici, donc mesurer
 * l'extracteur dessus est en partie circulaire. Le banc de mesure est le
 * livrable; le taux obtenu sur ce corpus n'est PAS predictif du reel.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const STYLE = `
  @page { size: A4; margin: 18mm; }
  body { font: 11pt/1.5 Georgia, serif; color: #1a1a1a; }
  h1 { font-size: 20pt; margin: 0 0 2pt; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: .08em;
       color: #7d2b3a; border-bottom: 1px solid #ccc; padding-bottom: 3pt;
       margin: 18pt 0 8pt; }
  .domaine { font-size: 13pt; color: #7d2b3a; margin: 0 0 14pt; }
  table { border-collapse: collapse; width: 100%; font-size: 10pt; }
  td, th { border: 1px solid #bbb; padding: 4pt 7pt; text-align: left; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 3pt 14pt; margin: 0; }
  dt { font-weight: bold; }
  dd { margin: 0; }
  .pied { margin-top: 26pt; font-size: 8.5pt; color: #666; border-top: 1px solid #ddd; padding-top: 6pt; }
`;

const FICHES = [
  {
    nom: 'domaine-a-tableau',
    html: `
      <p class="domaine">Domaine des Hauts Sentiers</p>
      <h1>Cuvee Le Serre</h1>
      <p>AOP Pic Saint-Loup &mdash; Millesime 2021 &mdash; Vin rouge</p>
      <h2>Caracteristiques</h2>
      <table>
        <tr><th>Cepages</th><td>Syrah 70 %, Grenache 20 %, Mourvedre 10 %</td></tr>
        <tr><th>Degre alcoolique</th><td>14,0 % vol.</td></tr>
        <tr><th>Elevage</th><td>15 mois en foudre de chene</td></tr>
        <tr><th>Rendement</th><td>38 hl/ha</td></tr>
        <tr><th>Certification</th><td>Agriculture biologique</td></tr>
      </table>
      <h2>Degustation</h2>
      <p>Robe pourpre soutenue. Le nez livre des fruits noirs compotes et une
      pointe de poivre blanc. La bouche est ample, portee par des tanins serres
      mais polis, et se prolonge sur une finale saline.</p>
      <h2>Accords</h2>
      <p>Epaule d'agneau confite, pigeon roti, tomme de brebis affinee.</p>
      <p class="pied">Domaine des Hauts Sentiers &middot; 34270 Valflaunes &middot; Fiche technique millesime 2021</p>`,
  },
  {
    nom: 'domaine-b-lignes',
    html: `
      <h1>Les Terrasses du Pic</h1>
      <p class="domaine">Mas de la Combe Noire &mdash; Pic Saint-Loup</p>
      <h2>Fiche technique</h2>
      <dl>
        <dt>Appellation</dt><dd>AOC Pic Saint-Loup</dd>
        <dt>Couleur</dt><dd>Rouge</dd>
        <dt>Millesime</dt><dd>2022</dd>
        <dt>Assemblage</dt><dd>55% syrah, 30% grenache noir, 15% mourvedre</dd>
        <dt>Titre alcoometrique</dt><dd>13.5% vol</dd>
        <dt>Vieillissement</dt><dd>12 mois en cuve inox puis 6 mois en bouteille</dd>
        <dt>Prix depart cave</dt><dd>15,80 &euro; TTC</dd>
      </dl>
      <h2>Notes de degustation</h2>
      <p>Nez expressif de cerise noire et de garrigue. Attaque souple, texture
      soyeuse, tanins fondus. La finale reste fraiche et mentholee.</p>
      <p class="pied">Mas de la Combe Noire &middot; Lauret</p>`,
  },
  {
    nom: 'domaine-c-prose',
    html: `
      <h1>L'Enclos &mdash; 2020</h1>
      <p class="domaine">Chateau de la Fontaine Vieille</p>
      <p>Notre cuvee parcellaire, en appellation Pic Saint-Loup, elaboree a
      partir d'un assemblage de 80 % de syrah et de 20 % de mourvedre. Elle
      titre 14,5 % vol. et connait un elevage de vingt-quatre mois en
      demi-muids.</p>
      <h2>Ce que nous y trouvons</h2>
      <p>Une robe grenat dense. Au nez, la mure et le cassis dominent, releves
      d'une note de reglisse. En bouche, le vin est puissant et charpente, les
      tanins sont fermes, la longueur est remarquable. A attendre trois ans.</p>
      <h2>A table</h2>
      <p>Civet de sanglier, cote de boeuf maturee.</p>
      <p class="pied">Chateau de la Fontaine Vieille &middot; Saint-Mathieu-de-Treviers &middot; 2020</p>`,
  },
];

const nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await nav.newContext()).newPage();

for (const fiche of FICHES) {
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${STYLE}</style>${fiche.html}`);
  const pdf = await page.pdf({ format: 'A4', printBackground: true });
  writeFileSync(`ingestion/fiches/${fiche.nom}.pdf`, pdf);
  console.log(`ingestion/fiches/${fiche.nom}.pdf (${pdf.length} octets)`);
}
await nav.close();
