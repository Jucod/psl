import type { PoliteFetcher } from './http.js';

/** A product as a shop publishes it, reduced to what extraction needs. */
export interface RawProduct {
  platform: 'shopify' | 'woocommerce';
  title: string;
  url: string;
  /** Plain text of the product page fields, in the order the shop gives them. */
  text: string;
  /** Labels the shop attaches to the product: categories, tags, attributes. */
  labels: string[];
  prices: { label: string; eur: number }[];
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', hellip: '…', ndash: '–', mdash: '—',
  deg: '°', euro: '€', oelig: 'œ', OElig: 'Œ', eacute: 'é', egrave: 'è', ecirc: 'ê',
  euml: 'ë', agrave: 'à', acirc: 'â', ccedil: 'ç', icirc: 'î', iuml: 'ï', ocirc: 'ô',
  ucirc: 'û', ugrave: 'ù', uuml: 'ü', Eacute: 'É', Egrave: 'È', Agrave: 'À', Ccedil: 'Ç',
};

export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name] ?? m)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// --- Shopify: /products.json --------------------------------------------------

interface ShopifyProduct {
  title: string;
  handle: string;
  body_html: string | null;
  product_type?: string;
  tags?: string[] | string;
  variants?: { title: string; price: string; available?: boolean }[];
}

export function fromShopify(base: string, p: ShopifyProduct): RawProduct {
  const tags = Array.isArray(p.tags) ? p.tags : (p.tags ?? '').split(',').map((t) => t.trim());
  return {
    platform: 'shopify',
    title: p.title.trim(),
    url: new URL(`/products/${p.handle}`, base).href,
    text: htmlToText(p.body_html),
    labels: [p.product_type ?? '', ...tags].filter(Boolean),
    prices: (p.variants ?? [])
      .map((v) => ({ label: v.title, eur: Number(v.price) }))
      .filter((v) => Number.isFinite(v.eur) && v.eur > 0),
  };
}

// --- WooCommerce: Store API ----------------------------------------------------

interface WooProduct {
  name: string;
  permalink: string;
  description?: string;
  short_description?: string;
  categories?: { name: string }[];
  tags?: { name: string }[];
  attributes?: { name: string; terms?: { name: string }[] }[];
  prices?: { price: string; currency_code?: string; currency_minor_unit?: number; price_range?: unknown };
}

export function fromWooCommerce(p: WooProduct): RawProduct {
  const attributes = (p.attributes ?? []).map(
    (a) => `${a.name} : ${(a.terms ?? []).map((t) => t.name).join(', ')}`,
  );
  const prices: RawProduct['prices'] = [];
  if (p.prices && p.prices.currency_code === 'EUR' && !p.prices.price_range) {
    const value = Number(p.prices.price) / 10 ** (p.prices.currency_minor_unit ?? 2);
    if (Number.isFinite(value) && value > 0) prices.push({ label: 'prix', eur: value });
  }
  return {
    platform: 'woocommerce',
    title: htmlToText(p.name),
    url: p.permalink,
    text: [htmlToText(p.short_description), htmlToText(p.description), ...attributes]
      .filter(Boolean).join('\n'),
    labels: [...(p.categories ?? []), ...(p.tags ?? [])].map((c) => htmlToText(c.name)),
    prices,
  };
}

// --- discovery ------------------------------------------------------------------

const MAX_PAGES = 10;

/**
 * Lists the products of a shop, whichever of the two public product APIs it
 * exposes. Returns null when it exposes neither: the site then needs HTML
 * parsing or a browser, which is out of scope for this tool.
 */
export async function listProducts(
  http: PoliteFetcher,
  website: string,
): Promise<RawProduct[] | null> {
  const base = new URL(website).origin + '/';

  const shopify = await tryJson(http, new URL('/products.json?limit=250&page=1', base).href);
  if (shopify && typeof shopify === 'object' && Array.isArray((shopify as any).products)) {
    const products: RawProduct[] = (shopify as any).products.map((p: ShopifyProduct) => fromShopify(base, p));
    for (let page = 2; page <= MAX_PAGES && products.length === (page - 1) * 250; page++) {
      const next = (await http.getJson(new URL(`/products.json?limit=250&page=${page}`, base).href)) as any;
      products.push(...(next.products ?? []).map((p: ShopifyProduct) => fromShopify(base, p)));
    }
    return products;
  }

  const woo = await tryJson(http, new URL('/wp-json/wc/store/v1/products?per_page=100&page=1', base).href);
  if (Array.isArray(woo)) {
    const products = woo.map((p: WooProduct) => fromWooCommerce(p));
    for (let page = 2; page <= MAX_PAGES && products.length === (page - 1) * 100; page++) {
      const next = await http.getJson(new URL(`/wp-json/wc/store/v1/products?per_page=100&page=${page}`, base).href);
      if (!Array.isArray(next)) break;
      products.push(...next.map((p: WooProduct) => fromWooCommerce(p)));
    }
    return products;
  }

  return null;
}

async function tryJson(http: PoliteFetcher, url: string): Promise<unknown> {
  try {
    return await http.getJson(url);
  } catch {
    return null;
  }
}
