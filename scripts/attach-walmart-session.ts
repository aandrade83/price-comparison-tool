/**
 * Attach to an existing Brave/Chrome session via CDP and capture Walmart
 * network responses from the already-authenticated, human-verified session.
 *
 * BEFORE RUNNING — launch Brave with remote debugging enabled:
 *
 *   Windows (PowerShell):
 *     & "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" `
 *         --remote-debugging-port=9222 `
 *         --remote-allow-origins=* `
 *         --no-first-run
 *
 *   Verify CDP is live:  http://localhost:9222/json
 *
 * RUN:
 *   npx tsx scripts/attach-walmart-session.ts
 */

import { chromium, type Page, type Response } from 'playwright';
import * as fs   from 'fs';
import * as path from 'path';

// ── Config ────────────────────────────────────────────────────────────────────

const CDP_URL      = 'http://localhost:9222';
const SEARCH_QUERY = 'Spam Classic 12 oz';
const CAPTURE_SECS = 20;
const DEBUG_DIR    = path.resolve(process.cwd(), 'debug');
const DEBUG_FILE   = path.join(DEBUG_DIR, 'attach-session.json');

// Walmart search box — try each in order until one is visible
const SEARCH_SELECTORS = [
  'input[name="query"]',
  '#global-search-input',
  'input[type="search"]',
  '[data-automation-id="search-input"]',
  '[aria-label*="search" i]',
  'form[role="search"] input',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeGet(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur ?? undefined;
}

function collectPricedItems(node: unknown, acc: unknown[] = []): unknown[] {
  if (node == null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { node.forEach(c => collectPricedItems(c, acc)); return acc; }
  const obj = node as Record<string, unknown>;
  if (safeGet(obj, 'priceInfo', 'currentPrice', 'price') != null) acc.push(obj);
  for (const v of Object.values(obj)) collectPricedItems(v, acc);
  return acc;
}

function findStoreIds(node: unknown, found = new Set<string>()): Set<string> {
  if (node == null || typeof node !== 'object') return found;
  if (Array.isArray(node)) { node.forEach(c => findStoreIds(c, found)); return found; }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k.toLowerCase() === 'storeid' && v != null) found.add(String(v));
    else findStoreIds(v, found);
  }
  return found;
}

interface ParsedProduct {
  productName:        string;
  brand:              string;
  usItemId:           string;
  offerId:            string;
  price:              number | null;
  priceString:        string;
  unitPriceString:    string;
  availabilityStatus: string;
  fulfillmentType:    string;
  fulfillmentTitle:   string;
  sellerName:         string;
  canonicalUrl:       string;
  storeIds:           string[];
  _sourceUrl:         string;
}

function parseItem(raw: unknown, sourceUrl: string): ParsedProduct | null {
  const obj  = raw as Record<string, unknown>;
  const name = String(
    safeGet(obj, 'name') ?? safeGet(obj, 'productName') ?? safeGet(obj, 'item', 'name') ?? ''
  ).trim();
  if (!name) return null;

  const rawPrice = safeGet(obj, 'priceInfo', 'currentPrice', 'price');
  const price    = rawPrice != null
    ? (typeof rawPrice === 'number' ? rawPrice : parseFloat(String(rawPrice)))
    : null;

  const canonical = String(safeGet(obj, 'canonicalUrl') ?? '').trim();

  return {
    productName:        name,
    brand:              String(safeGet(obj, 'brand')              ?? ''),
    usItemId:           String(safeGet(obj, 'usItemId')           ?? safeGet(obj, 'itemId') ?? ''),
    offerId:            String(safeGet(obj, 'offerId')            ?? ''),
    price,
    priceString:        String(safeGet(obj, 'priceInfo', 'currentPrice', 'priceString') ?? ''),
    unitPriceString:    String(safeGet(obj, 'priceInfo', 'unitPrice',    'priceString') ?? ''),
    availabilityStatus: String(safeGet(obj, 'availabilityStatus') ?? ''),
    fulfillmentType:    String(safeGet(obj, 'fulfillmentType')    ?? ''),
    fulfillmentTitle:   String(safeGet(obj, 'fulfillmentTitle')   ?? ''),
    sellerName:         String(safeGet(obj, 'sellerName')         ?? ''),
    canonicalUrl:       canonical
      ? (canonical.startsWith('http') ? canonical : `https://www.walmart.com${canonical}`)
      : '',
    storeIds:           [...findStoreIds(obj)],
    _sourceUrl:         sourceUrl,
  };
}

async function tryJson(res: Response): Promise<unknown | null> {
  try {
    const ct = res.headers()['content-type'] ?? '';
    if (!ct.includes('json') && !ct.includes('javascript')) return null;
    const text    = await res.text();
    const trimmed = text.trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function wait(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──────────────────────────────────────────────────────────────────────

interface Capture { url: string; storeIds: string[]; body: unknown; }

async function main() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  // ── 1. Connect via CDP ────────────────────────────────────────────────────
  console.log(`\nConnecting to CDP at ${CDP_URL} …`);
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\nFailed to connect: ${msg}`);
    console.error('Make sure Brave is running with:');
    console.error('  --remote-debugging-port=9222 --remote-allow-origins=*\n');
    process.exit(1);
  }
  console.log('Connected.');

  // ── 2. Find Walmart tab ───────────────────────────────────────────────────
  let walmartPage: Page | null = null;

  for (const ctx of browser.contexts()) {
    for (const pg of ctx.pages()) {
      const u = pg.url();
      console.log(`  tab: ${u}`);
      if (u.includes('walmart.com') && !walmartPage) walmartPage = pg;
    }
  }

  if (!walmartPage) {
    console.error('\nNo Walmart tab found. Open walmart.com in Brave first, then re-run.');
    await browser.close();
    process.exit(1);
  }

  console.log(`\nUsing tab: ${walmartPage.url()}`);

  // ── 3. Register response listener BEFORE any navigation ──────────────────
  const captures: Capture[]     = [];
  const candidateUrls: string[] = [];

  const handler = async (res: Response) => {
    const url    = res.url();
    const status = res.status();
    if (status < 200 || status >= 300) return;

    const rt = res.request().resourceType();
    if (!['xhr', 'fetch', 'document'].includes(rt)) return;

    const body = await tryJson(res);
    if (!body) return;

    const items    = collectPricedItems(body);
    const storeIds = [...findStoreIds(body)];
    if (items.length === 0 && storeIds.length === 0) return;

    const tag = items.length > 0 ? `${items.length} priced` : `storeId: ${storeIds.join(',')}`;
    console.log(`\n[+] (${tag})  ${url.slice(0, 120)}`);
    candidateUrls.push(url);
    captures.push({ url, storeIds, body });
  };

  walmartPage.on('response', handler);

  // ── 4. Reload to re-fire all network requests ─────────────────────────────
  const captureStart = Date.now();
  console.log('\n[reload] Reloading Walmart tab …');
  try {
    await walmartPage.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
    console.log('[reload] domcontentloaded');
  } catch {
    console.log('[reload] Timed out waiting for domcontentloaded — continuing anyway');
  }
  await wait(2_500); // let deferred XHRs fire after hydration

  // ── 5. Type search query in the search box ────────────────────────────────
  console.log(`\n[search] Looking for search box to type: "${SEARCH_QUERY}"`);
  let searchDone = false;

  for (const sel of SEARCH_SELECTORS) {
    try {
      const el = walmartPage.locator(sel).first();
      await el.waitFor({ state: 'visible', timeout: 4_000 });
      await el.click({ clickCount: 3 });   // select all existing text
      await el.fill(SEARCH_QUERY);
      await el.press('Enter');
      console.log(`[search] Submitted via: ${sel}`);
      searchDone = true;
      break;
    } catch {
      // try next selector
    }
  }

  if (!searchDone) {
    console.log('[search] Could not find search box — responses from reload will still be captured');
  }

  // ── 6. Wait for remaining capture window ──────────────────────────────────
  const elapsed   = Date.now() - captureStart;
  const remaining = Math.max(0, CAPTURE_SECS * 1_000 - elapsed);
  console.log(`\nCapturing for ${Math.round(remaining / 1000)} more seconds …`);
  await wait(remaining);

  walmartPage.off('response', handler);

  // ── 7. Parse ──────────────────────────────────────────────────────────────
  const allProducts: ParsedProduct[] = [];
  for (const cap of captures) {
    for (const raw of collectPricedItems(cap.body)) {
      const p = parseItem(raw, cap.url);
      if (p) allProducts.push(p);
    }
  }

  // ── 8. Print ──────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log(`CANDIDATE URLS  (${candidateUrls.length})`);
  console.log('═'.repeat(70));
  candidateUrls.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));

  console.log('\n' + '═'.repeat(70));
  console.log(`PARSED PRODUCTS  (${allProducts.length})`);
  console.log('═'.repeat(70));
  for (const p of allProducts) {
    console.log(`\n  productName        : ${p.productName}`);
    console.log(`  brand              : ${p.brand}`);
    console.log(`  usItemId           : ${p.usItemId}`);
    console.log(`  offerId            : ${p.offerId}`);
    console.log(`  price              : ${p.price}`);
    console.log(`  priceString        : ${p.priceString}`);
    console.log(`  unitPriceString    : ${p.unitPriceString}`);
    console.log(`  availabilityStatus : ${p.availabilityStatus}`);
    console.log(`  fulfillmentType    : ${p.fulfillmentType}`);
    console.log(`  fulfillmentTitle   : ${p.fulfillmentTitle}`);
    console.log(`  sellerName         : ${p.sellerName}`);
    console.log(`  canonicalUrl       : ${p.canonicalUrl}`);
    console.log(`  storeIds           : ${p.storeIds.join(', ') || '—'}`);
    console.log(`  _sourceUrl         : ${p._sourceUrl}`);
  }

  // ── 9. Save ───────────────────────────────────────────────────────────────
  const out = {
    capturedAt:     new Date().toISOString(),
    pageUrl:        walmartPage.url(),
    searchQuery:    SEARCH_QUERY,
    candidateUrls,
    parsedProducts: allProducts,
    rawCaptures:    captures,
  };

  fs.writeFileSync(DEBUG_FILE, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n[saved] ${DEBUG_FILE}`);

  // browser.close() on a CDP connection disconnects without killing Brave
  await browser.close();
}

main().catch(err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
