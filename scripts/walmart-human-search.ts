/**
 * Walmart price search through an attached human Brave session.
 *
 * All traffic originates from the real Brave browser — no direct Node fetches.
 * HTTP 418 bot challenges are impossible because Walmart sees a real human session.
 *
 * BEFORE RUNNING:
 *   Launch Brave with CDP enabled (one-time, keep it open):
 *
 *     & "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" `
 *         --remote-debugging-port=9222 --remote-allow-origins=* --no-first-run
 *
 *   Verify:  http://localhost:9222/json
 *
 * RUN:
 *   npx tsx scripts/walmart-human-search.ts
 *   npx tsx scripts/walmart-human-search.ts "Badia Cinnamon 2 oz"
 */

import { chromium, type Page, type BrowserContext, type Response } from 'playwright';
import * as fs   from 'fs';
import * as path from 'path';

// ── Config ────────────────────────────────────────────────────────────────────

const QUERY      = process.argv[2] ?? 'Spam Classic 12 oz';
const STORE_ID   = '5229';
const CDP_URL    = 'http://localhost:9222';
const WALMART    = 'https://www.walmart.com';
const DEBUG_DIR  = path.resolve(process.cwd(), 'debug');
const OUT_FILE   = path.join(DEBUG_DIR, 'walmart-human-search.json');

// ms between keystrokes — slow enough to look human
const TYPE_DELAY = 80;

const SEARCH_SELECTORS = [
  'input[name="query"]',
  '#global-search-input',
  'input[type="search"]',
  '[data-automation-id="search-input"]',
  '[aria-label*="Search" i] input',
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

interface Product {
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
}

function normalize(raw: unknown): Product | null {
  const obj  = raw as Record<string, unknown>;
  const name = String(
    safeGet(obj, 'name') ?? safeGet(obj, 'productName') ?? ''
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
      ? (canonical.startsWith('http') ? canonical : `${WALMART}${canonical}`)
      : '',
    storeIds: Array.from(findStoreIds(obj)),
  };
}

async function tryJson(res: Response): Promise<unknown | null> {
  try {
    const ct      = res.headers()['content-type'] ?? '';
    if (!ct.includes('json') && !ct.includes('javascript')) return null;
    const text    = await res.text();
    const trimmed = text.trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function wait(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

// ── Store context check ───────────────────────────────────────────────────────

async function verifyStore(page: Page): Promise<boolean> {
  try {
    const text = await page.locator('body').innerText({ timeout: 3_000 });
    return text.toLowerCase().includes('wyncote') ||
           text.includes(STORE_ID);
  } catch {
    return false;
  }
}

// ── Search box interaction ────────────────────────────────────────────────────

async function typeSearch(page: Page, query: string): Promise<boolean> {
  for (const sel of SEARCH_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      await el.waitFor({ state: 'visible', timeout: 5_000 });

      // bring into focus, clear existing value
      await el.click({ clickCount: 3 });
      await wait(200);
      await el.press('Control+a');
      await el.press('Delete');
      await wait(150);

      // type character by character so it looks human
      for (const ch of query) {
        await el.press(ch === ' ' ? 'Space' : ch);
        await wait(TYPE_DELAY + Math.random() * 40);
      }

      await wait(300);
      await el.press('Enter');
      console.log(`[search] Typed "${query}" via: ${sel}`);
      return true;
    } catch {
      // try next selector
    }
  }
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────

interface Capture { url: string; storeIds: string[]; items: unknown[]; }

async function main() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  console.log(`\nQuery   : "${QUERY}"`);
  console.log(`Store   : #${STORE_ID} Wyncote PA`);

  // ── 1. Connect ──────────────────────────────────────────────────────────────
  console.log(`\n[cdp] Connecting to ${CDP_URL} …`);
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  try {
    browser = await chromium.connectOverCDP(CDP_URL, { timeout: 5_000 });
  } catch (e) {
    console.error(`\n[cdp] Failed: ${(e as Error).message}`);
    console.error('Launch Brave with --remote-debugging-port=9222 --remote-allow-origins=*');
    process.exit(1);
  }
  console.log('[cdp] Connected.');

  // ── 2. Find or create Walmart tab ──────────────────────────────────────────
  let ctx:  BrowserContext;
  let page: Page;

  const allContexts = browser.contexts();
  let walmartPage: Page | null = null;

  for (const c of allContexts) {
    for (const pg of c.pages()) {
      if (pg.url().includes('walmart.com')) {
        walmartPage = pg;
        ctx = c;
        break;
      }
    }
    if (walmartPage) break;
  }

  if (walmartPage) {
    page = walmartPage;
    console.log(`[tab] Using existing Walmart tab: ${page.url()}`);
  } else {
    console.log('[tab] No Walmart tab found — opening one…');
    ctx = allContexts[0] ?? await browser.newContext();
    page = await ctx.newPage();
    await page.goto(`${WALMART}/search?q=${encodeURIComponent(QUERY)}`, {
      waitUntil: 'domcontentloaded',
      timeout:   30_000,
    });
    console.log(`[tab] Opened: ${page.url()}`);
  }

  // ── 3. Verify store context ─────────────────────────────────────────────────
  const storeOk = await verifyStore(page);
  if (storeOk) {
    console.log(`[store] Store #${STORE_ID} context confirmed on page`);
  } else {
    console.log(`[store] Store #${STORE_ID} not visible on current page — store cookies should still be active`);
  }

  // ── 4. Register response listener BEFORE triggering search ─────────────────
  const captures: Capture[] = [];

  const handler = async (res: Response) => {
    const url    = res.url();
    const status = res.status();
    if (status < 200 || status >= 300)                        return;
    if (!['xhr', 'fetch'].includes(res.request().resourceType())) return;

    const body = await tryJson(res);
    if (!body) return;

    const items    = collectPricedItems(body);
    const storeIds = Array.from(findStoreIds(body));
    if (items.length === 0 && storeIds.length === 0) return;

    const tag = items.length > 0
      ? `${items.length} priced`
      : `storeIds: ${storeIds.join(',')}`;
    console.log(`  [net] (${tag})  ${url.slice(0, 110)}`);
    captures.push({ url, storeIds, items });
  };

  page.on('response', handler);

  // ── 5. Type query and submit ────────────────────────────────────────────────
  console.log(`\n[search] Searching for "${QUERY}"…`);
  const typed = await typeSearch(page, QUERY);

  if (!typed) {
    // Fallback: navigate directly to search URL
    console.log('[search] Search box not found — navigating directly to search URL');
    await page.goto(
      `${WALMART}/search?q=${encodeURIComponent(QUERY)}`,
      { waitUntil: 'domcontentloaded', timeout: 30_000 },
    );
  }

  // ── 6. Wait for results ─────────────────────────────────────────────────────
  console.log('[wait] Waiting for results page to settle…');

  // Wait for at least one product tile
  try {
    await page.waitForSelector(
      '[data-item-id], [data-product-id], [data-automation-id="product"], ' +
      '[data-testid="list-view"], [itemprop="item"]',
      { timeout: 15_000 },
    );
    console.log('[wait] Product tiles detected');
  } catch {
    console.log('[wait] Product tile selector timed out — waiting anyway');
  }

  // Extra wait for deferred XHRs / lazy-loaded prices
  await wait(4_000);
  page.off('response', handler);

  // ── 7. Also check __NEXT_DATA__ as a fallback ───────────────────────────────
  const nextRaw = await page.evaluate(() =>
    document.getElementById('__NEXT_DATA__')?.textContent ?? null
  );
  if (nextRaw) {
    try {
      const nd    = JSON.parse(nextRaw);
      const items = collectPricedItems(nd);
      if (items.length > 0) {
        console.log(`[next] ${items.length} priced item(s) in __NEXT_DATA__`);
        captures.push({ url: '__NEXT_DATA__', storeIds: Array.from(findStoreIds(nd)), items });
      }
    } catch { /* ignore */ }
  }

  // ── 8. Normalize all captured items ────────────────────────────────────────
  const all: Product[] = [];
  for (const cap of captures) {
    for (const raw of cap.items) {
      const p = normalize(raw);
      if (p) all.push(p);
    }
  }

  // De-duplicate by usItemId (keep first occurrence — XHR before __NEXT_DATA__)
  const seen = new Set<string>();
  const deduped = all.filter(p => {
    if (!p.usItemId || seen.has(p.usItemId)) return false;
    seen.add(p.usItemId);
    return true;
  });

  // ── 9. Prefer STORE + Walmart.com + storeId 5229 ───────────────────────────
  const preferred = deduped.filter(
    p => p.fulfillmentType === 'STORE' &&
         p.sellerName      === 'Walmart.com' &&
         p.storeIds.includes(STORE_ID),
  );
  const display = preferred.length > 0 ? preferred : deduped;

  // ── 10. Print ───────────────────────────────────────────────────────────────
  const top10 = display.slice(0, 10);

  console.log('\n' + '═'.repeat(70));
  console.log(`RESULTS  ${preferred.length > 0 ? `(store-filtered: ${preferred.length})` : `(all: ${deduped.length})`}`);
  console.log('═'.repeat(70));

  for (const p of top10) {
    console.log(`\n  productName        : ${p.productName}`);
    console.log(`  brand              : ${p.brand || '—'}`);
    console.log(`  usItemId           : ${p.usItemId}`);
    console.log(`  offerId            : ${p.offerId}`);
    console.log(`  price              : ${p.price}`);
    console.log(`  priceString        : ${p.priceString}`);
    console.log(`  unitPriceString    : ${p.unitPriceString}`);
    console.log(`  availabilityStatus : ${p.availabilityStatus}`);
    console.log(`  fulfillmentType    : ${p.fulfillmentType}`);
    console.log(`  fulfillmentTitle   : ${p.fulfillmentTitle}`);
    console.log(`  sellerName         : ${p.sellerName}`);
    console.log(`  storeIds           : ${p.storeIds.join(', ') || '—'}`);
    console.log(`  canonicalUrl       : ${p.canonicalUrl.slice(0, 80)}`);
  }

  if (deduped.length === 0) {
    console.log('\n  No products captured.');
    console.log('  → Make sure the search results loaded in Brave.');
    console.log('  → Try running the script again with Brave already on walmart.com/search');
  }

  // ── 11. Save ────────────────────────────────────────────────────────────────
  const out = {
    capturedAt:     new Date().toISOString(),
    query:          QUERY,
    storeId:        STORE_ID,
    finalPageUrl:   page.url(),
    totalCaptured:  deduped.length,
    preferredCount: preferred.length,
    preferred,
    all:            deduped,
    captureLog:     captures.map(c => ({ url: c.url, storeIds: c.storeIds, itemCount: c.items.length })),
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n[saved] ${OUT_FILE}`);

  await browser.close();
}

main().catch(err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
