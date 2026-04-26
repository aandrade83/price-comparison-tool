/**
 * Walmart store #5229 (Wyncote PA) — price extraction viability test.
 *
 * Run:
 *   npx tsx scripts/test-walmart-store-5229.ts
 *
 * What it does:
 *   1. Opens a visible Chromium browser (not headless)
 *   2. Visits the store page so Walmart sets the store-5229 session cookies
 *   3. Optionally clicks "Set as my store" if the button is present
 *   4. Navigates to the search results for "Spam Classic 12 oz"
 *   5. Intercepts ALL XHR / fetch / graphql responses in parallel
 *   6. Finds responses that contain priceInfo.currentPrice.price
 *   7. Parses and prints each matched product
 *   8. Saves the raw matching JSON to debug/walmart-5229-spam.json
 */

import { chromium, type Response } from 'playwright';
import * as fs   from 'fs';
import * as path from 'path';

// ── Config ────────────────────────────────────────────────────────────────────

const STORE_ID    = '5229';
const STORE_URL   = `https://www.walmart.com/store/${STORE_ID}-wyncote-pa`;
const SEARCH_Q    = 'Spam Classic 12 oz';
const SEARCH_URL  = `https://www.walmart.com/search?q=${encodeURIComponent(SEARCH_Q)}&affinityOverride=store&stores=${STORE_ID}`;
const DEBUG_DIR   = path.resolve(process.cwd(), 'debug');
const DEBUG_FILE  = path.join(DEBUG_DIR, 'walmart-5229-spam.json');
const PAGE_TIMEOUT = 30_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeGet(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur ?? undefined;
}

/** Recursively collect every object in a tree that has priceInfo.currentPrice.price */
function collectPricedItems(node: unknown, found: unknown[] = []): unknown[] {
  if (node == null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) collectPricedItems(child, found);
    return found;
  }
  const obj = node as Record<string, unknown>;
  if (obj['priceInfo'] && safeGet(obj, 'priceInfo', 'currentPrice', 'price') != null) {
    found.push(obj);
  }
  for (const val of Object.values(obj)) collectPricedItems(val, found);
  return found;
}

interface ParsedProduct {
  storeId:            string;
  storeName:          string;
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
  _sourceUrl:         string;
}

function parseItem(item: unknown, sourceUrl: string): ParsedProduct | null {
  const obj = item as Record<string, unknown>;

  // product name can live at different depths
  const name =
    String(safeGet(obj, 'name')        ??
           safeGet(obj, 'productName') ??
           safeGet(obj, 'item', 'name') ?? '').trim();
  if (!name) return null;

  const rawPrice = safeGet(obj, 'priceInfo', 'currentPrice', 'price');
  const price    = rawPrice != null
    ? (typeof rawPrice === 'number' ? rawPrice : parseFloat(String(rawPrice)))
    : null;

  const canonical = String(safeGet(obj, 'canonicalUrl') ?? '').trim();

  return {
    storeId:            STORE_ID,
    storeName:          'Wyncote #5229',
    productName:        name,
    brand:              String(safeGet(obj, 'brand')              ?? ''),
    usItemId:           String(safeGet(obj, 'usItemId')           ?? safeGet(obj, 'itemId') ?? ''),
    offerId:            String(safeGet(obj, 'offerId')            ?? ''),
    price,
    priceString:        String(safeGet(obj, 'priceInfo', 'currentPrice', 'priceString')  ?? ''),
    unitPriceString:    String(safeGet(obj, 'priceInfo', 'unitPrice',    'priceString')  ?? ''),
    availabilityStatus: String(safeGet(obj, 'availabilityStatus') ?? ''),
    fulfillmentType:    String(safeGet(obj, 'fulfillmentType')    ?? ''),
    fulfillmentTitle:   String(safeGet(obj, 'fulfillmentTitle')   ?? ''),
    sellerName:         String(safeGet(obj, 'sellerName')         ?? ''),
    canonicalUrl:       canonical
      ? (canonical.startsWith('http') ? canonical : `https://www.walmart.com${canonical}`)
      : '',
    _sourceUrl:         sourceUrl,
  };
}

// ── Interceptor ───────────────────────────────────────────────────────────────

interface CapturedResponse {
  url:  string;
  body: unknown;
}

async function tryParseJson(res: Response): Promise<unknown | null> {
  try {
    const ct = res.headers()['content-type'] ?? '';
    if (!ct.includes('json') && !ct.includes('javascript')) return null;
    const text = await res.text();
    if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    slowMo:   50,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--start-maximized',
    ],
  });

  const context = await browser.newContext({
    userAgent:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:   { width: 1366, height: 768 },
    locale:     'en-US',
    timezoneId: 'America/New_York',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const captured: CapturedResponse[] = [];
  const candidateUrls: string[]      = [];

  // Intercept all responses and buffer those that look relevant
  context.on('response', async (res: Response) => {
    const url    = res.url();
    const status = res.status();
    if (status < 200 || status >= 300) return;

    // Only bother with XHR / fetch / document (skip images, fonts, css)
    const rt = res.request().resourceType();
    if (!['xhr', 'fetch', 'document', 'script'].includes(rt)) return;

    const body = await tryParseJson(res);
    if (!body) return;

    const items = collectPricedItems(body);
    if (items.length === 0) return;

    console.log(`\n[intercept] priceInfo found in: ${url} (${items.length} item(s))`);
    candidateUrls.push(url);
    captured.push({ url, body });
  });

  const page = await context.newPage();

  // ── Step 1: visit store page to anchor session to #5229 ──────────────────
  console.log(`\n[step 1] Opening store page: ${STORE_URL}`);
  try {
    await page.goto(STORE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await page.waitForTimeout(3_000);

    // Click "Set as my store" / "Make this my store" if it appears
    const storeBtn = page.locator(
      'button:has-text("Set as my store"), button:has-text("Make this my store"), ' +
      '[data-automation-id="set-store-btn"], [aria-label*="Set as my store"]'
    ).first();
    if (await storeBtn.isVisible({ timeout: 4_000 }).catch(() => false)) {
      console.log('[step 1] Clicking "Set as my store"…');
      await storeBtn.click();
      await page.waitForTimeout(2_000);
    } else {
      console.log('[step 1] Store button not visible — checking store cookie…');
    }
  } catch (e) {
    console.log(`[step 1] Warning: ${(e as Error).message}`);
  }

  // ── Step 2: manually set store cookies as a belt-and-suspenders measure ──
  console.log('[step 2] Setting store-affinity cookies…');
  const cookieDomain = '.walmart.com';
  await context.addCookies([
    { name: 'assortment-store-id', value: STORE_ID,   domain: cookieDomain, path: '/' },
    { name: 'pickup-store-id',     value: STORE_ID,   domain: cookieDomain, path: '/' },
    { name: 'store-id',            value: STORE_ID,   domain: cookieDomain, path: '/' },
  ]);

  // ── Step 3: navigate to search results ───────────────────────────────────
  console.log(`\n[step 3] Searching: "${SEARCH_Q}"`);
  console.log(`         URL: ${SEARCH_URL}`);
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

  // Wait for product tiles to appear
  const productTileSelector = '[data-item-id], [data-product-id], [data-automation-id="product"], [itemprop="item"]';
  try {
    await page.waitForSelector(productTileSelector, { timeout: 12_000 });
    console.log('[step 3] Product tiles detected.');
  } catch {
    console.log('[step 3] Product tile selector timed out — waiting 6 s anyway…');
  }
  await page.waitForTimeout(4_000); // let deferred XHRs complete

  // ── Step 4: also try extracting from __NEXT_DATA__ ───────────────────────
  console.log('\n[step 4] Extracting __NEXT_DATA__ from search page…');
  const nextDataRaw = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    return el?.textContent ?? null;
  });

  if (nextDataRaw) {
    try {
      const nextData = JSON.parse(nextDataRaw);
      const items    = collectPricedItems(nextData);
      if (items.length > 0) {
        console.log(`[step 4] Found ${items.length} priced item(s) in __NEXT_DATA__`);
        captured.push({ url: '__NEXT_DATA__', body: nextData });
      } else {
        console.log('[step 4] __NEXT_DATA__ parsed but no priceInfo found');
      }
    } catch {
      console.log('[step 4] Failed to parse __NEXT_DATA__');
    }
  } else {
    console.log('[step 4] __NEXT_DATA__ element not found');
  }

  // ── Step 5: parse and filter all captured items ───────────────────────────
  console.log('\n[step 5] Parsing all captured priced items…');
  const allParsed: ParsedProduct[] = [];

  for (const { url, body } of captured) {
    const rawItems = collectPricedItems(body);
    for (const raw of rawItems) {
      const parsed = parseItem(raw, url);
      if (parsed) allParsed.push(parsed);
    }
  }

  // Prefer STORE + IN_STOCK + Walmart.com seller; fall back to everything
  const storeItems = allParsed.filter(
    p => p.fulfillmentType === 'STORE' &&
         p.availabilityStatus === 'IN_STOCK' &&
         p.sellerName === 'Walmart.com',
  );
  const display = storeItems.length > 0 ? storeItems : allParsed;

  // ── Step 6: output ────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log(`RESULTS  (${display.length} product(s) — ${storeItems.length > 0 ? 'store-filtered' : 'all'})`);
  console.log('─'.repeat(60));

  for (const p of display) {
    console.log(`\n  productName      : ${p.productName}`);
    console.log(`  brand            : ${p.brand}`);
    console.log(`  usItemId         : ${p.usItemId}`);
    console.log(`  offerId          : ${p.offerId}`);
    console.log(`  storeId          : ${p.storeId}`);
    console.log(`  storeName        : ${p.storeName}`);
    console.log(`  price            : ${p.price}`);
    console.log(`  priceString      : ${p.priceString}`);
    console.log(`  unitPriceString  : ${p.unitPriceString}`);
    console.log(`  availabilityStatus: ${p.availabilityStatus}`);
    console.log(`  fulfillmentType  : ${p.fulfillmentType}`);
    console.log(`  fulfillmentTitle : ${p.fulfillmentTitle}`);
    console.log(`  sellerName       : ${p.sellerName}`);
    console.log(`  canonicalUrl     : ${p.canonicalUrl}`);
    console.log(`  _sourceUrl       : ${p._sourceUrl}`);
  }

  if (candidateUrls.length > 0) {
    console.log('\n─'.repeat(60));
    console.log('CANDIDATE NETWORK URLS WITH priceInfo:');
    candidateUrls.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
  }

  // ── Step 7: save full raw JSON of all matches ─────────────────────────────
  const saveData = {
    capturedAt:    new Date().toISOString(),
    storeId:       STORE_ID,
    storeName:     'Wyncote #5229',
    searchQuery:   SEARCH_Q,
    candidateUrls,
    parsedProducts: display,
    rawCaptures:   captured.map(c => ({ url: c.url, body: c.body })),
  };

  fs.writeFileSync(DEBUG_FILE, JSON.stringify(saveData, null, 2), 'utf8');
  console.log(`\n[saved] ${DEBUG_FILE}`);

  // Keep browser open 5 s so you can see the state
  await page.waitForTimeout(5_000);
  await browser.close();
}

main().catch(err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
