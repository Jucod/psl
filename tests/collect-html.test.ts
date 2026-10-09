import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractCandidate, type Producer } from '../src/collect/extract.js';
import { listProductsFromHtml, locs, productScore, readProductPage } from '../src/collect/html.js';
import { PoliteFetcher } from '../src/collect/http.js';
import { buildGrapeIndex } from '../src/ingest/util.js';

const grapeIndex = buildGrapeIndex(
  JSON.parse(readFileSync(new URL('../db/seed/grapes.json', import.meta.url), 'utf8')).grapes,
);
const ESTATE: Producer = { id: 'domaine-de-l-hortus', name: "Domaine de l'Hortus", website: 'https://www.domaine-hortus.fr/' };

/** Shaped like a PrestaShop 1.7 product page: JSON-LD, feature table, description block. */
const PRESTASHOP = `<!doctype html><html><head>
<title>Grande Cuvée 2021 - Domaine</title>
<link rel="canonical" href="https://www.domaine-hortus.fr/vins-rouges/12-grande-cuvee-2021.html">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList",
 "itemListElement":[{"@type":"ListItem","position":1,"name":"Accueil"},{"@type":"ListItem","position":2,"name":"AOP Pic Saint-Loup"}]}</script>
<script type="application/ld+json">{"@context":"https://schema.org/","@type":"Product","name":"Grande Cuvée 2021",
 "description":"<p>Vin rouge.</p>","offers":{"@type":"Offer","price":"24.90","priceCurrency":"EUR"}}</script>
</head><body>
<h1>Grande Cuvée 2021</h1>
<div class="product-description"><p>Robe pourpre intense. Nez de fruits noirs, de réglisse et de garrigue.</p>
<p>La bouche est ample, les tanins sont fins et serrés.</p></div>
<section class="product-features"><dl class="data-sheet">
<dt class="name">Cépages</dt><dd class="value">Syrah 70%, Grenache 20%, Mourvèdre 10%</dd>
<dt class="name">Degré</dt><dd class="value">14,5 % vol</dd></dl></section>
<footer>Livraison offerte dès 12 bouteilles</footer>
</body></html>`;

/** Shaped like a Wix Stores product page: JSON-LD with an AggregateOffer, description in a data-hook. */
const WIX = `<html><head>
<meta property="og:type" content="product">
<script type="application/ld+json">{"@context":"https://schema.org/","@type":"Product","name":"Rosé de Lune 2025",
 "category":"Vins rosés","offers":{"@type":"AggregateOffer","lowPrice":"12","highPrice":"68","priceCurrency":"EUR"}}</script>
</head><body><pre data-hook="description"><p>AOP Pic Saint-Loup rosé.</p><p>Nez de petits fruits rouges, bouche vive et fraîche.</p></pre></body></html>`;

/** Shaped like a WooCommerce page with Yoast: the Product sits in an @graph. */
const YOAST = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"WebPage","name":"Les Coteaux"},
 {"@type":["Product"],"name":"Les Coteaux 2022","description":"AOC Pic Saint-Loup rouge. Bouche souple et gourmande.",
  "offers":[{"@type":"Offer","price":"16.50","priceCurrency":"EUR"}]}]}</script></head><body></body></html>`;

/** Microdata only, as older themes do. */
const MICRODATA = `<html><body><div itemscope itemtype="https://schema.org/Product">
<h1 itemprop="name">Clos du Pic 2020</h1>
<div itemprop="description"><p>AOP Pic Saint-Loup rouge. Robe sombre, bouche dense.</p></div>
<span itemprop="price" content="21.00">21,00 €</span><meta itemprop="priceCurrency" content="EUR">
</div></body></html>`;

/** A showcase page: a wine, but no structured product data. */
const SHOWCASE = `<html><head><title>Nos vins</title></head><body><h1>Cuvée du Pic</h1><p>AOP Pic Saint-Loup rouge. Un rouge de garrigue.</p></body></html>`;

describe('HTML reader: product data in pages', () => {
  it('reads a PrestaShop page: JSON-LD, breadcrumb, description block, feature table', () => {
    const p = readProductPage(PRESTASHOP, 'https://www.domaine-hortus.fr/12-grande-cuvee-2021.html')!;
    expect(p.platform).toBe('html');
    expect(p.title).toBe('Grande Cuvée 2021');
    expect(p.url).toBe('https://www.domaine-hortus.fr/vins-rouges/12-grande-cuvee-2021.html');
    expect(p.labels).toContain('AOP Pic Saint-Loup');
    expect(p.prices).toEqual([{ label: 'prix', eur: 24.9 }]);
    expect(p.text).toMatch(/Cépages : Syrah 70%, Grenache 20%, Mourvèdre 10%/);
    expect(p.text).toMatch(/les tanins sont fins et serrés/);
    // Page chrome is not product text.
    expect(p.text).not.toMatch(/Livraison/);
  });

  it('reads a Wix page and keeps a price range as two prices', () => {
    const p = readProductPage(WIX, 'https://x.wixsite.com/product-page/rose-de-lune')!;
    expect(p.title).toBe('Rosé de Lune 2025');
    expect(p.prices.map((x) => x.eur)).toEqual([12, 68]);
    expect(p.text).toMatch(/bouche vive et fraîche/);
    expect(p.labels).toContain('Vins rosés');
  });

  it('finds the Product inside a Yoast @graph', () => {
    const p = readProductPage(YOAST, 'https://example.org/produit/les-coteaux-2022/')!;
    expect(p.title).toBe('Les Coteaux 2022');
    expect(p.prices).toEqual([{ label: 'prix', eur: 16.5 }]);
  });

  it('falls back on microdata', () => {
    const p = readProductPage(MICRODATA, 'https://example.org/clos-du-pic')!;
    expect(p.title).toBe('Clos du Pic 2020');
    expect(p.prices).toEqual([{ label: 'prix', eur: 21 }]);
    expect(p.text).toMatch(/bouche dense/);
  });

  it('does not read a page without product data', () => {
    expect(readProductPage(SHOWCASE, 'https://example.org/nos-vins/')).toBeNull();
  });

  it('feeds the same extractor as the APIs, with the same guarantees', () => {
    const p = readProductPage(PRESTASHOP, 'https://www.domaine-hortus.fr/12-grande-cuvee-2021.html')!;
    const r = extractCandidate(p, ESTATE, grapeIndex, '2026-10-09');
    if (r.kind !== 'candidate') throw new Error(`excluded: ${r.reason}`);
    const w = r.candidate.wine;
    // The appellation comes from the breadcrumb, the color from the description.
    expect(w.appellation_id).toBe('aoc-pic-saint-loup');
    expect(w.color).toBe('red');
    expect(w.vintage).toBe(2021);
    expect(w.abv).toBe(14.5);
    expect(w.price_eur).toBe(24.9);
    expect(w.blend).toEqual([
      { grape: 'syrah', pct: 70 }, { grape: 'grenache', pct: 20 }, { grape: 'mourvedre', pct: 10 },
    ]);
    expect(w.tasting_note).toMatch(/^Robe pourpre intense\./);
    expect(r.candidate.toComplete).toEqual([]);
  });
});

describe('HTML reader: finding the product pages', () => {
  it('ranks product-looking addresses and leaves the rest out', () => {
    expect(productScore('https://d.fr/vins-rouges/12-grande-cuvee-2021.html')).toBeGreaterThan(0);
    expect(productScore('https://d.fr/produit/rose-2025/')).toBeGreaterThan(0);
    expect(productScore('https://d.fr/blog/vendanges-2024/')).toBe(-1);
    expect(productScore('https://d.fr/mentions-legales')).toBeLessThanOrEqual(0);
    expect(productScore('https://d.fr/wp-content/uploads/etiquette.jpg')).toBe(-1);
  });

  it('reads sitemap indexes and URL sets', () => {
    expect(locs('<sitemapindex><sitemap><loc>https://d.fr/product-sitemap.xml</loc></sitemap></sitemapindex>'))
      .toEqual({ kind: 'index', urls: ['https://d.fr/product-sitemap.xml'] });
    expect(locs('<urlset><url><loc> https://d.fr/a?x=1&amp;y=2 </loc></url></urlset>').urls)
      .toEqual(['https://d.fr/a?x=1&y=2']);
  });

  it('goes from robots.txt to the product sitemap to the pages, politely', async () => {
    const requested: string[] = [];
    const pages: Record<string, string> = {
      '/robots.txt': 'User-agent: *\nDisallow: /panier\nSitemap: https://www.domaine-hortus.fr/1_index_sitemap.xml\n',
      '/1_index_sitemap.xml':
        '<sitemapindex><sitemap><loc>https://www.domaine-hortus.fr/1_fr_0_sitemap.xml</loc></sitemap>' +
        '<sitemap><loc>https://www.domaine-hortus.fr/1_fr_product_sitemap.xml</loc></sitemap></sitemapindex>',
      '/1_fr_product_sitemap.xml':
        '<urlset><url><loc>https://www.domaine-hortus.fr/vins-rouges/12-grande-cuvee-2021.html</loc></url>' +
        '<url><loc>https://www.domaine-hortus.fr/nos-vins/cuvee-du-pic-saint-loup</loc></url>' +
        '<url><loc>https://other-site.fr/produit/x</loc></url></urlset>',
      '/1_fr_0_sitemap.xml': '<urlset><url><loc>https://www.domaine-hortus.fr/blog/news</loc></url></urlset>',
      '/vins-rouges/12-grande-cuvee-2021.html': PRESTASHOP,
      '/nos-vins/cuvee-du-pic-saint-loup': SHOWCASE,
    };
    const fake = async (url: string | URL | Request) => {
      const u = new URL(String(url));
      requested.push(u.host === 'www.domaine-hortus.fr' ? u.pathname : u.href);
      const body = pages[u.pathname];
      return body === undefined ? new Response('not found', { status: 404 }) : new Response(body);
    };
    const http = new PoliteFetcher({
      userAgent: 'psl-catalog-research/0.1 (+me@example.org)',
      fetch: fake as typeof fetch,
      sleep: async () => {},
    });

    const result = await listProductsFromHtml(http, 'https://www.domaine-hortus.fr/', 40);

    expect(result.via).toBe('sitemap');
    expect(result.products.map((p) => p.title)).toEqual(['Grande Cuvée 2021']);
    // A wine page without product data is reported, not guessed.
    expect(result.withoutData).toEqual(['https://www.domaine-hortus.fr/nos-vins/cuvee-du-pic-saint-loup']);
    // Another site's page is never fetched; the product sitemap is read before the generic one.
    expect(requested).not.toContain('https://other-site.fr/produit/x');
    expect(requested.indexOf('/1_fr_product_sitemap.xml')).toBeLessThan(requested.indexOf('/1_fr_0_sitemap.xml'));
  });

  it('crawls from the home page when there is no sitemap', async () => {
    const pages: Record<string, string> = {
      '/': '<a href="/nos-vins/">Nos vins</a><a href="/contact">Contact</a>',
      '/nos-vins/': '<a href="/nos-vins/les-coteaux-2022/">Les Coteaux</a>',
      '/nos-vins/les-coteaux-2022/': YOAST,
    };
    const fake = async (url: string | URL | Request) => {
      const body = pages[new URL(String(url)).pathname];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body);
    };
    const http = new PoliteFetcher({ userAgent: 'psl/0.1', fetch: fake as typeof fetch, sleep: async () => {} });
    const result = await listProductsFromHtml(http, 'https://example.org/', 40);
    expect(result.via).toBe('crawl');
    expect(result.products.map((p) => p.title)).toEqual(['Les Coteaux 2022']);
  });
});
