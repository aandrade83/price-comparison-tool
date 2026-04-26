/**
 * Aldi.us GraphQL product catalog scraper.
 *
 * Uses the Instacart Storefront Pro GraphQL API (Apollo Persisted Queries).
 * No Playwright needed — pure HTTP via Node.js fetch.
 *
 * Auth flow:
 *   GET https://www.aldi.us/ → capture __Host-instacart_sid cookie
 *   POST https://www.aldi.us/graphql with Cookie header on every request
 *
 * Discovery strategy:
 *   1. StorefrontPlacements  → extract all collection slugs from response
 *   2. DepartmentNavCollections → named departments
 *   3. DesktopSidebarNavigations → nav tree slugs
 *   4. Seed list of known / guessed slugs
 *   5. For each slug: CollectionProductsWithFeaturedProducts
 *      → first=10 (get itemIds.length) then first=totalCount (all details)
 *
 * Target: 500+ unique products saved to debug/aldi-catalog.json
 *
 * RUN: npx tsx scripts/aldi-graphql-scraper.ts
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

// ── Config ─────────────────────────────────────────────────────────────────────

const GRAPHQL_URL  = 'https://www.aldi.us/graphql';
const HOME_URL     = 'https://www.aldi.us/';
const SHOP_ID      = '89454';
const POSTAL_CODE  = '19138';
const ZONE_ID      = '861';

const DEBUG_DIR = path.resolve(process.cwd(), 'debug');
const OUT_FILE  = path.join(DEBUG_DIR, 'aldi-catalog.json');

// APQ hashes extracted from Aldi.us initial HTML page state
const HASHES: Record<string, string> = {
  StorefrontPlacements:              '289590e5adad09f70c124052662c92aceca5684fc5b3761d44835e77b8cc1833',
  SlotPlacements:                    'a9246674d3c7b3167e4f460d8515eb6fd53f89f235e95b42bd27ecc55b67e813',
  CollectionProductsWithFeaturedProducts: '5573f6ef85bfad81463b431985396705328c5ac3283c4e183aa36c6aad1afafe',
  DepartmentNavCollections:          'ecf77405d43648a4e53301584a57165728a5ccc942b06f3a8a57ad342ef46013',
  CategoryItemIds:                   'a9e63a4a97dd3a052186cba0740b8f9c61e04eab00cb0d4b134942372babe324',
  DesktopSidebarNavigations:         '9a1d47b127e37caaac2ba7ec9b8d967eb29d2eb4401384939aa1e40c6265cece',
  ShopCollectionScoped:              'c6a0fcb3d1a4a14e5800cc6c38e736e85177f80f0c01a5535646f83238e65bcb',
  SimpleShopCollection:              'd438f50ce0c6b59526c922754c7908bfbfa073c8893f466f0276f40a0074501a',
};

// Confirmed + plausible collection slugs to probe
const SEED_SLUGS = [
  // Confirmed working
  'rc-weekly-ad',
  'rc-price-drops',
  'n-aldi-brands-11323',
  'n-shop-by-diet-95504',
  // Seasonal / promotional (discovered via StorefrontPlacements previously)
  'rc-all-summer-seasonals',
  'rc-new-arrivals',
  'rc-fan-favorites',
  'rc-best-sellers',
  'rc-snacks-sweets',
  'rc-breakfast',
  'rc-beverages',
  'rc-baking-essentials',
  'rc-cooking-essentials',
  'rc-condiments-sauces',
  'rc-dairy',
  'rc-produce',
  'rc-deli',
  'rc-meat-seafood',
  'rc-frozen',
  'rc-bakery',
  'rc-pasta-rice-grains',
  'rc-canned-goods',
  'rc-household',
  'rc-personal-care',
  'rc-baby',
  'rc-pet',
  'rc-health-wellness',
  'rc-wine',
  'rc-beer',
  'rc-coffee-tea',
  'rc-international',
  'rc-organic',
  'rc-gluten-free',
  'rc-vegan',
  // Numeric-suffix aldi brand collections
  'n-aldi-brands',
  'n-fresh-produce',
  'n-dairy-eggs',
  'n-meat-seafood',
  'n-frozen-foods',
  'n-pantry',
  'n-beverages',
  'n-snacks',
  'n-bakery',
  'n-household',
  'n-personal-care',
  'n-baby',
  'n-pet',
  'n-health-wellness',
  // Explore pages
  'explore-all-products',
  'featured',
  'sale',
  'deals',
];

// ── Types ──────────────────────────────────────────────────────────────────────

interface ProductRecord {
  id:    string;
  name:  string;
  brand: string | null;
  size:  string | null;
  price: string | null;
  store: 'Aldi';
  source: 'aldi';
}

interface RawItem {
  id:          string;
  name:        string;
  size?:       string | null;
  productId?:  string;
  brandName?:  string | null;
  availability?: { available: boolean };
  price?: {
    viewSection?: {
      priceValueString?: string;
      priceString?: string;
      pricePerUnitString?: string;
    };
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function randDelay(min = 400, max = 900) { return min + Math.random() * (max - min); }

/** Walk any JSON tree and collect slug-like strings */
function collectSlugs(obj: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof obj === 'string') {
    // Collection slugs: lowercase alphanumeric + hyphens, 4+ chars, has at least one hyphen
    if (/^[a-z][a-z0-9-]{3,}$/.test(obj) && obj.includes('-')) out.add(obj);
  } else if (Array.isArray(obj)) {
    for (const v of obj) collectSlugs(v, out);
  } else if (obj !== null && typeof obj === 'object') {
    for (const v of Object.values(obj as Record<string, unknown>)) collectSlugs(v, out);
  }
  return out;
}

/** Resolve the top-level collection object from various response shapes */
function getCollectionObj(data: unknown): Record<string, unknown> | null {
  const d = data as Record<string, unknown>;
  // Confirmed: CollectionProductsWithFeaturedProducts → data.collectionProducts
  const col =
    d?.collectionProducts ??
    d?.collection ??
    d?.shopCollection ??
    d?.collectionScoped;
  if (!col || typeof col !== 'object') return null;
  return col as Record<string, unknown>;
}

/** Extract RawItem[] from whatever shape the API returns */
function extractItems(data: unknown): RawItem[] {
  const c = getCollectionObj(data);
  if (!c) return [];

  const rawItems = c.items ?? c.products;
  if (!rawItems) return [];
  if (Array.isArray(rawItems)) return rawItems as RawItem[];

  // Relay edges pattern
  const ri = rawItems as Record<string, unknown>;
  if (Array.isArray(ri.edges)) {
    return (ri.edges as Array<{ node: RawItem }>).map(e => e.node);
  }
  return [];
}

/** Extract itemIds (total count indicator) from collection response */
function extractItemIds(data: unknown): string[] {
  const c = getCollectionObj(data);
  if (!c) return [];
  return Array.isArray(c.itemIds) ? (c.itemIds as string[]) : [];
}

// ── GraphQL client ─────────────────────────────────────────────────────────────

async function gqlPost(
  operationName: string,
  variables: Record<string, unknown>,
  cookie: string,
): Promise<unknown> {
  const hash = HASHES[operationName];
  if (!hash) throw new Error(`No hash for operation: ${operationName}`);

  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'Cookie':       cookie,
      'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Origin':       'https://www.aldi.us',
      'Referer':      'https://www.aldi.us/',
    },
    body: JSON.stringify({
      operationName,
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json() as { data?: unknown; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    const msg = json.errors[0].message;
    throw new Error(msg);
  }

  return json.data;
}

// ── Auth ───────────────────────────────────────────────────────────────────────

async function getSessionCookie(): Promise<string> {
  console.log('[auth] Fetching homepage for session cookie...');

  const res = await fetch(HOME_URL, {
    redirect: 'follow',
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!res.ok) throw new Error(`Homepage HTTP ${res.status}`);

  // Parse Set-Cookie headers — Node 18+ fetch supports getSetCookie()
  let cookies: string[] = [];
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') {
    cookies = h.getSetCookie();
  } else {
    const raw = h.get('set-cookie') ?? '';
    cookies = raw ? [raw] : [];
  }

  // Collect all relevant cookies into a single Cookie header
  const cookieParts: string[] = [];
  for (const c of cookies) {
    const nameValue = c.split(';')[0].trim();
    if (nameValue) cookieParts.push(nameValue);
  }

  const sidPart = cookieParts.find(p => p.includes('instacart_sid') || p.includes('_instacart'));
  if (!sidPart) {
    // Still proceed — some responses carry the session in a follow-up redirect
    console.warn('[auth] Warning: instacart_sid cookie not found in response headers');
    console.warn('[auth] Proceeding with available cookies:', cookieParts.slice(0, 3).join(', '));
  }

  const cookieStr = cookieParts.join('; ');
  console.log(`[auth] Cookie string (${cookieParts.length} cookies): ${cookieStr.slice(0, 80)}...`);
  return cookieStr;
}

// ── Collection discovery ───────────────────────────────────────────────────────

async function discoverSlugs(cookie: string): Promise<string[]> {
  const discovered = new Set<string>();

  // 1. StorefrontPlacements
  for (const variables of [
    { shopId: SHOP_ID, postalCode: POSTAL_CODE, zoneId: ZONE_ID, first: 50, coordinates: COORDS },
    { shopId: SHOP_ID, postalCode: POSTAL_CODE, zoneId: ZONE_ID, first: 50, coordinates: COORDS, pageSlug: 'storefront' },
  ]) {
    try {
      process.stdout.write('[discover] StorefrontPlacements... ');
      const data = await gqlPost('StorefrontPlacements', variables, cookie);
      const raw = collectSlugs(data);
      // Keep only plausible collection slugs
      const plausible = [...raw].filter(s =>
        /^(rc-|n-[a-z]|c-[a-z]|featured|explore|sale|deals|seasonal)/.test(s)
      );
      plausible.forEach(s => discovered.add(s));
      fs.writeFileSync(
        path.join(DEBUG_DIR, 'aldi-storefront-placements.json'),
        JSON.stringify(data, null, 2), 'utf8',
      );
      console.log(`${plausible.length} slugs found`);
      break;
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
    }
    await sleep(400);
  }

  // 2. DepartmentNavCollections with various context hints
  for (const variables of [
    { shopId: SHOP_ID, postalCode: POSTAL_CODE, zoneId: ZONE_ID },
    { shopId: SHOP_ID, postalCode: POSTAL_CODE, zoneId: ZONE_ID, departmentSlug: 'all' },
  ]) {
    try {
      const data = await gqlPost('DepartmentNavCollections', variables, cookie);
      collectSlugs(data).forEach(s => discovered.add(s));
    } catch { /* ignore */ }
    await sleep(300);
  }

  // 3. DesktopSidebarNavigations
  try {
    const data = await gqlPost('DesktopSidebarNavigations', {
      shopId: SHOP_ID, postalCode: POSTAL_CODE, zoneId: ZONE_ID,
    }, cookie);
    collectSlugs(data).forEach(s => discovered.add(s));
  } catch { /* ignore */ }

  // 4. Seed list
  SEED_SLUGS.forEach(s => discovered.add(s));

  console.log(`[discover] Total slugs to probe: ${discovered.size}`);
  return [...discovered];
}

// ── Fetch one collection (all pages) ──────────────────────────────────────────

const COORDS = { latitude: 40.062, longitude: -75.132 }; // Philadelphia, PA

function baseVars() {
  return {
    shopId:        SHOP_ID,
    postalCode:    POSTAL_CODE,
    zoneId:        ZONE_ID,
    moduleItemCount: 10,
    pageViewId:    randomUUID(),
    coordinates:   COORDS,
  };
}

async function fetchAllFromCollection(collSlug: string, cookie: string): Promise<RawItem[]> {
  // Pass 1: small fetch to discover total itemIds count
  let pass1: unknown;
  try {
    pass1 = await gqlPost('CollectionProductsWithFeaturedProducts', {
      ...baseVars(), slug: collSlug, first: 10,
    }, cookie);
  } catch {
    return [];
  }

  const itemIds = extractItemIds(pass1);
  if (itemIds.length === 0) return [];

  const total = itemIds.length;

  // Pass 2: request all items at once — server may cap at some limit
  let allItems: RawItem[] = [];

  try {
    const pass2 = await gqlPost('CollectionProductsWithFeaturedProducts', {
      ...baseVars(), slug: collSlug, first: total,
    }, cookie);
    allItems = extractItems(pass2);
  } catch {
    // Fall back to what pass1 gave us
    allItems = extractItems(pass1);
  }

  // If server capped, paginate via ShopCollectionScoped (cursor-based)
  if (allItems.length < total) {
    try {
      let after: string | undefined;
      const PAGE = 40;

      while (allItems.length < total) {
        const pageData = await gqlPost('ShopCollectionScoped', {
          shopId:     SHOP_ID,
          slug:       collSlug,
          postalCode: POSTAL_CODE,
          zoneId:     ZONE_ID,
          coordinates: { latitude: 40.062, longitude: -75.132 },
          first:      PAGE,
          ...(after ? { after } : {}),
        }, cookie);

        const pageItems = extractItems(pageData);
        if (pageItems.length === 0) break;

        allItems.push(...pageItems);

        // Look for next cursor
        const d = pageData as Record<string, unknown>;
        const col = (d?.collection ?? d?.shopCollection) as Record<string, unknown> | undefined;
        const pageInfo = (col?.items as Record<string, unknown>)?.pageInfo as Record<string, unknown> | undefined;
        if (!pageInfo?.hasNextPage) break;
        after = pageInfo.endCursor as string;

        await sleep(randDelay(300, 600));
      }
    } catch { /* pagination not available — use what we have */ }
  }

  return allItems;
}

// ── Normalise raw item to ProductRecord ───────────────────────────────────────

function toRecord(item: RawItem): ProductRecord {
  const pid = item.productId ?? item.id.replace(/^items_\d+-/, '');
  return {
    id:    pid,
    name:  item.name,
    brand: item.brandName ?? null,
    size:  item.size ?? null,
    price: item.price?.viewSection?.priceValueString ?? null,
    store: 'Aldi',
    source: 'aldi',
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  const cookie = await getSessionCookie();
  console.log('');

  const slugs = await discoverSlugs(cookie);
  console.log('');

  const productMap = new Map<string, ProductRecord>();
  const report: Array<{ slug: string; fetched: number; total: number }> = [];
  let debugDumped = false;

  for (const slug of slugs) {
    process.stdout.write(`  ${slug.padEnd(44)}`);

    try {
      // Quick probe: does this collection exist at all?
      const probe = await gqlPost('CollectionProductsWithFeaturedProducts', {
        ...baseVars(), slug, first: 1,
      }, cookie) as Record<string, unknown>;

      // Debug: dump the first probe response so we can inspect the shape
      if (!debugDumped) {
        debugDumped = true;
        fs.writeFileSync(
          path.join(DEBUG_DIR, 'aldi-probe-debug.json'),
          JSON.stringify(probe, null, 2), 'utf8',
        );
        console.log(`\n  [debug] first probe response saved to aldi-probe-debug.json\n`);
      }

      const ids = extractItemIds(probe);
      if (ids.length === 0) {
        console.log('  —  (empty/null)');
        report.push({ slug, fetched: 0, total: 0 });
        await sleep(randDelay(200, 400));
        continue;
      }

      const total = ids.length;
      await sleep(randDelay(300, 600));

      // Full fetch
      const items = await fetchAllFromCollection(slug, cookie);
      let newCount = 0;
      for (const item of items) {
        const rec = toRecord(item);
        if (!productMap.has(rec.id)) {
          productMap.set(rec.id, rec);
          newCount++;
        }
      }

      console.log(`  ${String(items.length).padStart(4)}/${String(total).padStart(4)} items  (+${String(newCount).padStart(3)} new)  total=${productMap.size}`);
      report.push({ slug, fetched: items.length, total });
    } catch (err) {
      const msg = (err as Error).message;
      // Silently skip "Not Authenticated" / "not found" type errors
      if (/not auth|not found|null/i.test(msg)) {
        console.log('  —  (auth/null)');
      } else {
        console.log(`  ERROR: ${msg.slice(0, 60)}`);
      }
      report.push({ slug, fetched: 0, total: -1 });
    }

    await sleep(randDelay(400, 800));
  }

  const catalog = [...productMap.values()];

  const line = '─'.repeat(60);
  console.log('\n' + line);
  console.log(`Unique products collected: ${catalog.length}`);
  console.log('\nCollections with results:');
  report
    .filter(r => r.fetched > 0)
    .sort((a, b) => b.fetched - a.fetched)
    .forEach(r => console.log(`  ${r.slug.padEnd(40)} ${r.fetched}/${r.total}`));
  console.log(line + '\n');

  // Sample a few products
  if (catalog.length > 0) {
    console.log('Sample products:');
    catalog.slice(0, 5).forEach(p =>
      console.log(`  [${p.id}] ${p.name}${p.brand ? ` (${p.brand})` : ''} ${p.size ?? ''} — $${p.price ?? '?'}`)
    );
    console.log('');
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    scrapedAt:     new Date().toISOString(),
    postalCode:    POSTAL_CODE,
    shopId:        SHOP_ID,
    totalProducts: catalog.length,
    collectionsProbed: slugs.length,
    collectionsWithResults: report.filter(r => r.fetched > 0).length,
    collections:   report,
    products:      catalog,
  }, null, 2), 'utf8');

  console.log(`[saved] ${OUT_FILE}`);
}

main().catch(err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
