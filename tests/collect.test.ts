import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractCandidate, isVerbatim, type Producer } from '../src/collect/extract.js';
import { PoliteFetcher } from '../src/collect/http.js';
import { fromShopify, fromWooCommerce, htmlToText, listProducts } from '../src/collect/platforms.js';
import { checkGrapeRules, reviewCandidate, type GrapeRules } from '../src/collect/review.js';
import { isAllowed, parseRobots } from '../src/collect/robots.js';
import { buildGrapeIndex } from '../src/ingest/util.js';

const seed = JSON.parse(readFileSync(new URL('../db/seed/pic-saint-loup-seed.json', import.meta.url), 'utf8'));
const grapeIndex = buildGrapeIndex(
  JSON.parse(readFileSync(new URL('../db/seed/grapes.json', import.meta.url), 'utf8')).grapes,
);
const rules: GrapeRules = seed.appellations[0].grape_rules;
const MORTIES: Producer = { id: 'domaine-de-morties', name: 'Domaine de Morties', website: 'https://morties.com/' };
const BRUGUIERE: Producer = { id: 'mas-bruguiere', name: 'Mas Bruguière', website: 'http://mas-bruguiere.com/' };
const DAY = '2026-10-07';

/** Shaped like Shopify's /products.json. */
const shopifyRed = {
  title: 'Les Terrasses 2023 - AOP Pic Saint-Loup Rouge',
  handle: 'les-terrasses-2023',
  product_type: 'Vin rouge',
  tags: ['AOP Pic Saint-Loup', 'Bio'],
  body_html:
    '<p>Assemblage : 60% Syrah, 30% Grenache, 10% Mourv&egrave;dre.</p>' +
    '<p>Robe grenat profond. Le nez &eacute;voque les fruits noirs et la garrigue.</p>' +
    '<p>En bouche, les tanins sont souples et la finale reste fra&icirc;che.</p>' +
    '<p>&Eacute;levage de 12 mois en foudre.</p><p>14,5 % vol.</p>' +
    '<p>Livraison offerte d&egrave;s 6 bouteilles.</p>',
  variants: [{ title: '75 cl', price: '18.50' }, { title: 'Carton de 6', price: '105.00' }],
};

/** Shaped like WooCommerce's Store API. */
const wooRose = {
  name: 'Rosé du Pic 2025',
  permalink: 'https://mas-bruguiere.com/produit/rose-du-pic-2025/',
  short_description: '<p>AOP Pic Saint-Loup ros&eacute;.</p>',
  description:
    '<p>Syrah, grenache et cinsault.</p>' +
    '<p>Nez de petits fruits rouges et d&rsquo;agrumes, bouche vive et d&eacute;salt&eacute;rante.</p>',
  categories: [{ name: 'Rosés' }],
  attributes: [{ name: 'Millésime', terms: [{ name: '2025' }] }],
  prices: { price: '1300', currency_code: 'EUR', currency_minor_unit: 2, price_range: null },
};

describe('collector: from shop data to candidate', () => {
  it('turns a Shopify product into a complete candidate', () => {
    const r = extractCandidate(fromShopify('https://morties.com/', shopifyRed), MORTIES, grapeIndex, DAY);
    expect(r.kind).toBe('candidate');
    if (r.kind !== 'candidate') return;
    const w = r.candidate.wine;

    expect(w.id).toBe('morties-les-terrasses-rouge-2023');
    expect(w.name).toBe('Les Terrasses');
    expect(w.color).toBe('red');
    expect(w.vintage).toBe(2023);
    expect(w.blend).toEqual([
      { grape: 'syrah', pct: 60 }, { grape: 'grenache', pct: 30 }, { grape: 'mourvedre', pct: 10 },
    ]);
    expect(w.abv).toBe(14.5);
    expect(w.aging).toBe('Élevage de 12 mois en foudre.');
    // The 75 cl price, not the carton's.
    expect(w.price_eur).toBe(18.5);
    expect(w.price_as_of).toBe(DAY);
    expect(w.organic).toBe(true);
    expect(w.page_url).toBe('https://morties.com/products/les-terrasses-2023');

    // Descriptive sentences only, copied as they are; delivery terms left out.
    expect(w.tasting_note).toBe(
      'Robe grenat profond. Le nez évoque les fruits noirs et la garrigue. ' +
      'En bouche, les tanins sont souples et la finale reste fraîche.',
    );
    expect(isVerbatim(w.tasting_note!, r.candidate.sourceText)).toBe(true);
    expect(w.tasting_note_source?.content_sha256).toHaveLength(64);
  });

  it('reads a WooCommerce product, and "fruits rouges" does not make a rose red', () => {
    const r = extractCandidate(fromWooCommerce(wooRose), BRUGUIERE, grapeIndex, DAY);
    expect(r.kind).toBe('candidate');
    if (r.kind !== 'candidate') return;
    const w = r.candidate.wine;
    expect(w.color).toBe('rose');
    expect(w.vintage).toBe(2025);
    expect(w.price_eur).toBe(13);
    expect(w.blend.map((b) => b.grape)).toEqual(['syrah', 'grenache', 'cinsaut']);
    expect(w.blend.every((b) => b.pct === null)).toBe(true);
    expect(w.name).toBe('Rosé du Pic');
    expect(w.id).toBe('mas-bruguiere-rose-du-pic-2025');
  });

  it.each([
    ['a white wine', { ...shopifyRed, title: 'Blanc des Garrigues 2024 - AOP Pic Saint-Loup' }, 'white'],
    ['a gift box', { ...shopifyRed, title: 'Coffret découverte AOP Pic Saint-Loup' }, 'single bottle'],
    ['a magnum', { ...shopifyRed, title: 'Les Terrasses 2023 Magnum' }, 'format'],
    ['a sparkling wine', { ...shopifyRed, title: 'Bulles du Pic', body_html: '<p>Méthode traditionnelle, AOP Pic Saint-Loup.</p>' }, 'sparkling'],
    ['a pet-nat', { ...shopifyRed, title: 'Pet Nat 2024 - AOP Pic Saint-Loup rosé' }, 'sparkling'],
    ['another designation, no Pic Saint-Loup', { ...shopifyRed, title: 'Les Mûriers 2024', tags: [],
      body_html: '<p>IGP Saint-Guilhem-le-Désert, vin rouge.</p>' }, 'another designation'],
  ])('excludes only what is certainly not a bottle of Pic Saint-Loup: %s', (_label, product, reason) => {
    const r = extractCandidate(fromShopify('https://morties.com/', product), MORTIES, grapeIndex, DAY);
    expect(r.kind).toBe('excluded');
    if (r.kind === 'excluded') expect(r.reason).toMatch(reason);
  });

  it.each([
    ['names the terroir, not the appellation (the Tonillieres case)',
      { ...shopifyRed, title: 'Les Tonillieres 2022', tags: [], product_type: 'Vin rouge',
        body_html: '<p>Un rouge de notre terroir du Pic Saint-Loup. Bouche fraiche et fruitee.</p>' },
      'appellation_id', /as a place/],
    ['states no appellation at all',
      { ...shopifyRed, title: 'Le Cazal 2021', tags: [], product_type: 'Vin rouge',
        body_html: '<p>Bouche ronde, tanins fondus, finale sur la reglisse.</p>' },
      'appellation_id', /no appellation/],
    ['does not say the color',
      { ...shopifyRed, title: 'Cuvée X 2022 - AOP Pic Saint-Loup', tags: [], product_type: 'Vin',
        body_html: '<p>Nez de cassis, bouche ample et tanins serres.</p>' },
      'color', /does not say/],
  ])('keeps a page that %s, with the field left empty for the reviewer', (_label, product, field, why) => {
    const r = extractCandidate(fromShopify('https://morties.com/', product), MORTIES, grapeIndex, DAY);
    if (r.kind !== 'candidate') throw new Error(`excluded: ${r.reason}`);
    expect((r.candidate.wine as Record<string, unknown>)[field]).toBeNull();
    expect(r.candidate.toComplete.join()).toMatch(why);
  });

  it('recognizes the former name of the appellation', () => {
    const product = { ...shopifyRed, title: 'Vieilles Vignes 2014', tags: [],
      body_html: '<p>AOC Coteaux du Languedoc Pic Saint-Loup rouge. Robe profonde, bouche dense.</p>' };
    const r = extractCandidate(fromShopify('https://morties.com/', product), MORTIES, grapeIndex, DAY);
    if (r.kind !== 'candidate') throw new Error(`excluded: ${r.reason}`);
    expect(r.candidate.wine.appellation_id).toBe('aoc-pic-saint-loup');
    expect(r.candidate.toComplete).toEqual([]);
    expect(r.candidate.flags.join()).not.toMatch(/another designation/);
  });

  it('flags instead of guessing: several prices, no vintage, no grape', () => {
    const product = {
      ...shopifyRed, title: 'Cuvée Secrète - AOP Pic Saint-Loup rouge',
      body_html: '<p>Robe sombre, nez de cassis et de poivre, bouche ample.</p>',
      variants: [{ title: '75 cl', price: '18.50' }, { title: '75 cl millésime ancien', price: '25.00' }],
    };
    const r = extractCandidate(fromShopify('https://morties.com/', product), MORTIES, grapeIndex, DAY);
    if (r.kind !== 'candidate') throw new Error(`excluded: ${r.reason}`);
    expect(r.candidate.wine.price_eur).toBeNull();
    expect(r.candidate.wine.vintage).toBeNull();
    const flags = r.candidate.flags.join('\n');
    expect(flags).toMatch(/several prices/);
    expect(flags).toMatch(/vintage not found/);
    expect(flags).toMatch(/no grape/);
  });

  it('drops a trailing color from the name, as in the existing catalog', () => {
    const r = extractCandidate(
      fromShopify('https://morties.com/', { ...shopifyRed, title: 'Dame Jeanne Rosé 2025 - AOP Pic Saint-Loup' }),
      MORTIES, grapeIndex, DAY,
    );
    if (r.kind !== 'candidate') throw new Error(`excluded: ${r.reason}`);
    expect(r.candidate.wine.name).toBe('Dame Jeanne');
    expect(r.candidate.wine.id).toBe('morties-dame-jeanne-rose-2025');
  });

  it('decodes the HTML the shops send', () => {
    expect(htmlToText('<p>Nez d&rsquo;&eacute;pices&nbsp;:<br>cassis &amp; m&ucirc;re</p>'))
      .toBe('Nez d’épices :\ncassis & mûre');
  });
});

describe('collector: promotion checks', () => {
  const ctx = {
    grapeIndex, rules,
    producerIds: new Set(['domaine-de-morties', 'mas-bruguiere']),
    existing: [] as never[],
  };
  const candidate = () => {
    const r = extractCandidate(fromShopify('https://morties.com/', shopifyRed), MORTIES, grapeIndex, DAY);
    if (r.kind !== 'candidate') throw new Error('excluded');
    return r.candidate;
  };

  it('accepts a clean candidate', () => {
    const c = candidate();
    expect(reviewCandidate(c.wine, c.sourceText, ctx).errors).toEqual([]);
  });

  it('refuses a note edited by hand during review', () => {
    const c = candidate();
    const edited = { ...c.wine, tasting_note: c.wine.tasting_note!.replace('souples', 'soyeux') };
    expect(reviewCandidate(edited, c.sourceText, ctx).errors.join()).toMatch(/not made of sentences copied/);
  });

  it('refuses a candidate to complete until the reviewer has set the field', () => {
    const product = { ...shopifyRed, tags: [], product_type: 'Vin rouge', title: 'Le Cazal 2021',
      body_html: '<p>Bouche ronde, tanins fondus, finale sur la reglisse.</p>' };
    const r = extractCandidate(fromShopify('https://morties.com/', product), MORTIES, grapeIndex, DAY);
    if (r.kind !== 'candidate') throw new Error('excluded');
    expect(reviewCandidate(r.candidate.wine, r.candidate.sourceText, ctx).errors.join())
      .toMatch(/appellation_id is not set/);
    const completed = { ...r.candidate.wine, appellation_id: 'aoc-pic-saint-loup' };
    expect(reviewCandidate(completed, r.candidate.sourceText, ctx).errors).toEqual([]);
  });

  it('recognizes a known wine despite the accents the first collection dropped', () => {
    const c = candidate();
    const stored = { ...c.wine, id: 'other-id', name: 'Les Terrasses', color: 'red' } as never;
    const accented = { ...c.wine, name: 'Lés Térrasses' };
    expect(reviewCandidate(accented, c.sourceText, { ...ctx, existing: [stored] }).errors.join())
      .toMatch(/already in the catalog as other-id/);
  });

  it('refuses a wine that is already in the catalog', () => {
    const c = candidate();
    const v = reviewCandidate(c.wine, c.sourceText, { ...ctx, existing: [c.wine] as never[] });
    expect(v.errors.join()).toMatch(/already in the catalog/);
  });

  it('enforces the AOC grape rules, read from the seed', () => {
    const blend = (b: [string, number | null][]) => b.map(([grape, pct]) => ({ grape, pct }));
    expect(checkGrapeRules({ color: 'red', blend: blend([['syrah', 40], ['grenache', 60]]) }, rules, grapeIndex).errors)
      .toEqual(['syrah 40% < 50% required']);
    expect(checkGrapeRules({ color: 'red', blend: blend([['syrah', 70], ['grenache', 15], ['carignan', 15]]) }, rules, grapeIndex).errors)
      .toEqual(['secondary grapes 15% > 10%']);
    expect(checkGrapeRules({ color: 'red', blend: blend([['syrah', null], ['chardonnay', null]]) }, rules, grapeIndex).errors)
      .toContain('chardonnay is not a permitted grape for this color');
    // Without figures, a short list may be incomplete: a warning, not a refusal.
    const partial = checkGrapeRules({ color: 'red', blend: blend([['syrah', null]]) }, rules, grapeIndex);
    expect(partial.errors).toEqual([]);
    expect(partial.warnings).toHaveLength(1);
  });

  it('every wine already in the catalog passes the AOC grape rules', () => {
    const dir = new URL('../db/seed/wines/', import.meta.url);
    for (const f of readdirSync(dir)) {
      const w = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      expect(checkGrapeRules(w, rules, grapeIndex).errors, f).toEqual([]);
    }
  });
});

describe('collector: network manners', () => {
  it('reads robots.txt groups and longest-match rules', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /wp-json/\nAllow: /wp-json/wc/store/\n\nUser-agent: badbot\nDisallow: /\n',
      'psl-catalog-research/0.1 (+me@example.org)',
    );
    expect(isAllowed(rules, '/wp-json/wp/v2/users')).toBe(false);
    expect(isAllowed(rules, '/wp-json/wc/store/v1/products?per_page=100')).toBe(true);
    expect(isAllowed(rules, '/products.json')).toBe(true);
  });

  it('honors robots.txt, identifies itself, waits between requests, and finds the shop API', async () => {
    const calls: { url: string; ua: string | null }[] = [];
    const waits: number[] = [];
    const fake = async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      calls.push({ url: u.pathname, ua: new Headers(init?.headers).get('user-agent') });
      if (u.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /products.json\n');
      if (u.pathname === '/wp-json/wc/store/v1/products') return Response.json([wooRose]);
      return new Response('not found', { status: 404 });
    };
    const http = new PoliteFetcher({
      userAgent: 'psl-catalog-research/0.1 (+me@example.org)',
      fetch: fake as typeof fetch,
      sleep: async (ms) => { waits.push(ms); },
    });

    const products = await listProducts(http, 'https://mas-bruguiere.com/la-boutique/');

    expect(products?.map((p) => p.title)).toEqual(['Rosé du Pic 2025']);
    // Shopify's endpoint is disallowed: it was never requested.
    expect(calls.map((c) => c.url)).toEqual(['/robots.txt', '/wp-json/wc/store/v1/products']);
    expect(calls.every((c) => c.ua?.startsWith('psl-catalog-research/'))).toBe(true);
    expect(waits.length).toBeGreaterThan(0);
  });
});
