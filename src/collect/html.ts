import { parse, type HTMLElement } from 'node-html-parser';
import type { PoliteFetcher } from './http.js';
import { htmlToText, type RawProduct } from './platforms.js';

/**
 * Reads wines from shops that expose no product API (PrestaShop, Wix,
 * WordPress themes...), without one parser per site.
 *
 * It relies on what almost every e-commerce platform publishes for search
 * engines: sitemaps to find the product pages, and schema.org Product data on
 * each page (JSON-LD first, then microdata, then Open Graph). A page without
 * any of them is not read as a product: it is reported, to be looked at by
 * hand, rather than guessed from its layout.
 */

// --- reading one page ------------------------------------------------------------

type Json = Record<string, any>;

/** Containers that platforms and themes use for the product description. */
const DESCRIPTION_SELECTORS = [
  '#description', '.product-description', '.product__description', '.product-single__description',
  '.woocommerce-product-details__short-description', '.woocommerce-Tabs-panel--description',
  '#tab-description', '[data-hook="description"]', '.product-information .rte', '.rte',
];
/** Feature tables: vintage, grapes, alcohol, often there rather than in the prose. */
const FEATURE_SELECTORS = [
  '.data-sheet', '.product-features', 'table.shop_attributes', '.woocommerce-product-attributes',
  '[data-hook="info-section-description"]', 'dl.features',
];

export function readProductPage(html: string, pageUrl: string): RawProduct | null {
  const root = parse(html);
  const nodes = jsonLdNodes(root);
  const products = nodes.filter((n) => hasType(n, 'Product'));
  const micros = root.querySelectorAll('[itemtype*="schema.org/Product"]');
  const product = products[0];
  const micro = micros[0] ?? null;
  const ogType = meta(root, 'og:type');
  if (!product && !micro && !/product/.test(ogType ?? '')) return null;
  // A home or range page carrying a grid of products is not a product page:
  // read as one, it became a wine named "Accueil" with the whole range as its
  // text. Its products have their own pages, which the crawl reaches.
  if (products.length > 1 || micros.length > 1) return null;

  const title = clean(
    str(product?.name) ?? itemprop(micro, 'name') ?? meta(root, 'og:title') ??
    root.querySelector('h1')?.text ?? '',
  );
  if (!title) return null;

  const parts: string[] = [];
  const add = (text: string | null | undefined) => {
    const t = text?.trim();
    if (!t) return;
    // Platforms repeat the same description in several places.
    if (parts.some((p) => p.includes(t))) return;
    for (let i = parts.length - 1; i >= 0; i--) if (t.includes(parts[i]!)) parts.splice(i, 1);
    parts.push(t);
  };
  add(htmlToText(str(product?.description)));
  add(micro ? htmlToText(micro.querySelector('[itemprop="description"]')?.innerHTML) : null);
  for (const sel of DESCRIPTION_SELECTORS) {
    for (const el of root.querySelectorAll(sel)) add(htmlToText(el.innerHTML));
  }
  for (const sel of FEATURE_SELECTORS) {
    for (const el of root.querySelectorAll(sel)) add(features(el));
  }
  add(additionalProperties(product));
  if (parts.length === 0) add(meta(root, 'og:description') ?? meta(root, 'description', 'name'));

  const breadcrumb = nodes.filter((n) => hasType(n, 'BreadcrumbList'))
    .flatMap((b) => (b.itemListElement ?? []).map((i: Json) => str(i.name) ?? str(i.item?.name)))
    .filter((x): x is string => Boolean(x));
  const labels = [
    ...[product?.category].flat().map(str),
    itemprop(micro, 'category'),
    ...breadcrumb,
  ].filter((x): x is string => Boolean(x)).map(clean);

  const canonical = root.querySelector('link[rel="canonical"]')?.getAttribute('href');
  return {
    platform: 'html',
    title,
    url: absolute(canonical ?? str(product?.url) ?? pageUrl, pageUrl),
    text: parts.join('\n'),
    labels,
    prices: prices(product, micro, root),
  };
}

function jsonLdNodes(root: HTMLElement): Json[] {
  const out: Json[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      out.push(v as Json);
      if (Array.isArray((v as Json)['@graph'])) walk((v as Json)['@graph']);
    }
  };
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      walk(JSON.parse(script.rawText.trim()));
    } catch {
      // Malformed JSON-LD is common; the other channels remain.
    }
  }
  return out;
}

function hasType(node: Json, type: string): boolean {
  const t = node['@type'];
  return Array.isArray(t) ? t.includes(type) : t === type;
}

function prices(product: Json | undefined, micro: HTMLElement | null, root: HTMLElement): RawProduct['prices'] {
  const out: RawProduct['prices'] = [];
  const push = (label: string, value: unknown, currency: unknown) => {
    const eur = Number(String(value ?? '').replace(',', '.'));
    if (Number.isFinite(eur) && eur > 0 && (currency == null || currency === 'EUR')) out.push({ label, eur });
  };
  for (const offer of [product?.offers].flat().filter(Boolean) as Json[]) {
    if (hasType(offer, 'AggregateOffer') && offer.lowPrice !== offer.highPrice) {
      push('prix bas', offer.lowPrice, offer.priceCurrency);
      push('prix haut', offer.highPrice, offer.priceCurrency);
    } else {
      push(str(offer.name) ?? 'prix', offer.price ?? offer.lowPrice, offer.priceCurrency);
    }
  }
  if (out.length === 0 && micro) {
    const el = micro.querySelector('[itemprop="price"]');
    const currency = micro.querySelector('[itemprop="priceCurrency"]');
    push('prix', el?.getAttribute('content') ?? el?.text, currency?.getAttribute('content') ?? currency?.text?.trim() ?? null);
  }
  if (out.length === 0) {
    push('prix', meta(root, 'product:price:amount'), meta(root, 'product:price:currency') ?? null);
  }
  return out;
}

function features(el: HTMLElement): string {
  const lines: string[] = [];
  for (const row of el.querySelectorAll('tr')) {
    const cells = row.querySelectorAll('th, td').map((c) => clean(c.text));
    if (cells.length >= 2) lines.push(`${cells[0]} : ${cells.slice(1).join(' ')}`);
  }
  const dts = el.querySelectorAll('dt');
  for (const dt of dts) {
    const dd = dt.nextElementSibling;
    if (dd && dd.tagName === 'DD') lines.push(`${clean(dt.text)} : ${clean(dd.text)}`);
  }
  return lines.length > 0 ? lines.join('\n') : htmlToText(el.innerHTML);
}

function additionalProperties(product: Json | undefined): string {
  return [product?.additionalProperty].flat().filter(Boolean)
    .map((p: Json) => `${str(p.name) ?? ''} : ${str(p.value) ?? ''}`)
    .filter((l) => !l.startsWith(' :')).join('\n');
}

function itemprop(scope: HTMLElement | null, name: string): string | undefined {
  const el = scope?.querySelector(`[itemprop="${name}"]`);
  return el ? (el.getAttribute('content') ?? clean(el.text)) || undefined : undefined;
}

function meta(root: HTMLElement, key: string, attr: 'property' | 'name' = 'property'): string | undefined {
  const el = root.querySelector(`meta[${attr}="${key}"]`) ?? root.querySelector(`meta[name="${key}"]`);
  return el?.getAttribute('content')?.trim() || undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined;
}

function clean(t: string): string {
  return htmlToText(t).replace(/\s+/g, ' ').trim();
}

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return base;
  }
}

// --- finding the product pages ---------------------------------------------------

const NOT_A_PRODUCT = /\/(blog|actualites?|news|tag|author|auteur|contact|mentions|cgv|conditions|panier|cart|checkout|commande|account|compte|mon-compte|login|connexion|recrutement|presse|evenements?|events?)(\/|$)|\.(jpe?g|png|gif|webp|svg|pdf|zip|css|js)$/i;
const PRODUCT_HINTS: [RegExp, number][] = [
  [/\/(produit|product|products|product-page|boutique|shop|store)\//i, 3],
  [/\/\d+-[^/]+\.html$/i, 3],          // PrestaShop product URLs
  [/pic[-_]?s(ain)?t[-_]?loup/i, 2],
  [/\b(vins?|cuvees?|nos-vins|rouges?|roses?)\b/i, 1],
  [/\b(19[89]\d|20[0-4]\d)\b/, 1],
];

export function productScore(url: string): number {
  if (NOT_A_PRODUCT.test(url)) return -1;
  const path = (() => {
    try {
      return decodeURIComponent(new URL(url).pathname);
    } catch {
      return url;
    }
  })();
  return PRODUCT_HINTS.reduce((s, [re, w]) => s + (re.test(path) ? w : 0), 0);
}

function sameSite(url: string, origin: string): boolean {
  try {
    const host = (h: string) => h.replace(/^www\./, '');
    return host(new URL(url).hostname) === host(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function locs(xml: string): { kind: 'index' | 'urls'; urls: string[] } {
  const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
    .map((m) => m[1]!.replace(/&amp;/g, '&'));
  return { kind: /<sitemapindex[\s>]/i.test(xml) ? 'index' : 'urls', urls };
}

async function fromSitemaps(http: PoliteFetcher, origin: string): Promise<string[]> {
  const declared = await http.declaredSitemaps(origin);
  const queue = declared.length > 0
    ? declared
    : ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml'].map((p) => new URL(p, origin).href);
  const pages = new Set<string>();
  const seen = new Set<string>();

  for (let i = 0; i < queue.length && seen.size < 12; i++) {
    const url = queue[i]!;
    if (seen.has(url)) continue;
    seen.add(url);
    let xml: string;
    try {
      xml = await http.getText(url);
    } catch {
      continue;
    }
    const found = locs(xml);
    if (found.kind === 'index') {
      // Product sitemaps first; posts and images last.
      const rank = (u: string) => (/product|produit|shop|boutique|store|vin/i.test(u) ? 0 : /post|image|video|author|tag|categor/i.test(u) ? 2 : 1);
      queue.push(...found.urls.filter((u) => sameSite(u, origin)).sort((a, b) => rank(a) - rank(b)));
    } else {
      for (const u of found.urls) if (sameSite(u, origin)) pages.add(u);
    }
    // The first sitemaps that answer are enough when nothing was declared.
    if (declared.length === 0 && pages.size > 0 && found.kind === 'urls') break;
  }
  return [...pages];
}

async function fromCrawl(http: PoliteFetcher, origin: string): Promise<string[]> {
  const links = new Set<string>();
  const collect = (html: string, base: string) => {
    for (const a of parse(html).querySelectorAll('a[href]')) {
      const href = absolute(a.getAttribute('href')!, base).split('#')[0]!;
      if (sameSite(href, origin)) links.add(href);
    }
  };
  try {
    collect(await http.getText(origin), origin);
  } catch {
    return [];
  }
  // One level further, through the pages that look like a wine list.
  const listings = [...links]
    .filter((u) => /boutique|shop|store|nos-vins|vins|cuvees|produits|products/i.test(u))
    .slice(0, 5);
  for (const page of listings) {
    try {
      collect(await http.getText(page), page);
    } catch {
      // A listing that fails costs nothing: the others remain.
    }
  }
  return [...links];
}

export interface HtmlCollection {
  products: RawProduct[];
  via: 'sitemap' | 'crawl';
  pagesRead: number;
  /** Wine-looking pages without product data: to look at by hand. */
  withoutData: string[];
}

export async function listProductsFromHtml(
  http: PoliteFetcher,
  website: string,
  maxPages = 40,
): Promise<HtmlCollection> {
  const origin = new URL(website).origin + '/';
  let via: HtmlCollection['via'] = 'sitemap';
  let urls = await fromSitemaps(http, origin);
  if (urls.length === 0) {
    via = 'crawl';
    urls = await fromCrawl(http, origin);
  }

  const ranked = urls
    .map((u) => ({ u, score: productScore(u) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPages)
    .map((x) => x.u);

  const products: RawProduct[] = [];
  const withoutData: string[] = [];
  const seenTitles = new Set<string>();
  for (const url of ranked) {
    let html: string;
    try {
      html = await http.getText(url);
    } catch {
      continue;
    }
    const product = readProductPage(html, url);
    if (product) {
      // The same product is often reachable under several URLs.
      const key = product.title.toLowerCase();
      if (!seenTitles.has(key)) {
        seenTitles.add(key);
        products.push(product);
      }
    } else if (productScore(url) >= 2) {
      withoutData.push(url);
    }
  }
  return { products, via, pagesRead: ranked.length, withoutData };
}
