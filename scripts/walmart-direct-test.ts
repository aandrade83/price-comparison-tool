/**
 * Walmart direct GraphQL viability test.
 *
 * Reads the captured endpoint from debug/attach-session.json, rebuilds the
 * request with fresh variables, steals cookies from the live Brave session
 * (if available), and fires a plain Node.js fetch — no browser UI needed.
 *
 * If it works → we can skip Playwright entirely for price collection.
 * If it 403s  → we keep the attach-session browser approach.
 *
 * RUN (Brave CDP optional but recommended):
 *   npx tsx scripts/walmart-direct-test.ts
 */

import { chromium }  from 'playwright';
import * as fs       from 'fs';
import * as path     from 'path';

// ── Config ────────────────────────────────────────────────────────────────────

const QUERY      = 'Spam Classic 12 oz';
const STORE_ID   = '5229';
const CDP_URL    = 'http://localhost:9222';
const DEBUG_DIR  = path.resolve(process.cwd(), 'debug');
const INPUT_FILE = path.join(DEBUG_DIR, 'attach-session.json');
const OUT_FILE   = path.join(DEBUG_DIR, 'walmart-direct-test.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeGet(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur ?? undefined;
}

/** Deep-replace every string field named "query" anywhere in the tree */
function replaceQuery(node: unknown, newQuery: string): unknown {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(c => replaceQuery(c, newQuery));
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'query' && typeof v === 'string') out[k] = newQuery;
    else out[k] = replaceQuery(v, newQuery);
  }
  return out;
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
      ? (canonical.startsWith('http') ? canonical : `https://www.walmart.com${canonical}`)
      : '',
    storeIds: Array.from(findStoreIds(obj)),
  };
}

// ── Step 1 — read attach-session.json ─────────────────────────────────────────

function loadSession(): { graphqlUrl: string; userAgent: string } {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`\nInput file not found: ${INPUT_FILE}`);
    console.error('Run scripts/attach-walmart-session.ts first.\n');
    process.exit(1);
  }

  const session = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8')) as {
    candidateUrls: string[];
  };

  const graphqlUrl = session.candidateUrls.find(
    u => u.includes('/orchestra/snb/graphql/Search/') && u.includes('/search?variables='),
  );

  if (!graphqlUrl) {
    console.error('\nNo matching GraphQL Search URL found in candidateUrls.');
    console.error('candidateUrls present:');
    session.candidateUrls.forEach(u => console.error('  ', u));
    process.exit(1);
  }

  console.log(`[session] GraphQL URL found:\n  ${graphqlUrl.slice(0, 100)}…`);
  return { graphqlUrl, userAgent: '' };
}

// ── Step 2 — rebuild URL with fresh variables ─────────────────────────────────

function buildUrl(template: string, newQuery: string): string {
  const parsed  = new URL(template);
  const rawVars = parsed.searchParams.get('variables');

  if (!rawVars) throw new Error('No "variables" param in GraphQL URL');

  const vars    = JSON.parse(rawVars) as Record<string, unknown>;

  // Replace every "query" string field recursively
  const updated = replaceQuery(vars, newQuery) as Record<string, unknown>;

  // Ensure pagination params are sane
  updated.page  = 1;
  updated.ps    = 40;
  updated.limit = 40;
  if (updated.searchParams && typeof updated.searchParams === 'object') {
    (updated.searchParams as Record<string, unknown>).page  = 1;
    (updated.searchParams as Record<string, unknown>).ps    = 40;
    (updated.searchParams as Record<string, unknown>).limit = 40;
  }

  parsed.searchParams.set('variables', JSON.stringify(updated));
  return parsed.toString();
}

// ── Step 3 — steal cookies from live Brave session (optional) ─────────────────

async function getBraveCookies(): Promise<string> {
  try {
    const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 4_000 });
    const [ctx]   = browser.contexts();
    if (!ctx) { await browser.close(); return ''; }

    const cookies = await ctx.cookies('https://www.walmart.com');
    await browser.close();

    const cookieStr = cookies
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    console.log(`[cookies] Stole ${cookies.length} cookies from Brave session`);
    return cookieStr;
  } catch {
    console.log('[cookies] Brave CDP not available — proceeding without session cookies');
    return '';
  }
}

// ── Step 4 — direct fetch ─────────────────────────────────────────────────────

async function directFetch(
  url: string,
  cookieStr: string,
): Promise<{ status: number; body: unknown; raw: string }> {

  const headers: Record<string, string> = {
    'accept':           'application/json',
    'accept-language':  'en-US,en;q=0.9',
    'accept-encoding':  'gzip, deflate, br',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'referer':          `https://www.walmart.com/search?q=${encodeURIComponent(QUERY)}`,
    'origin':           'https://www.walmart.com',
    'sec-ch-ua':        '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest':   'empty',
    'sec-fetch-mode':   'cors',
    'sec-fetch-site':   'same-origin',
  };

  if (cookieStr) headers['cookie'] = cookieStr;

  const res = await fetch(url, {
    method:  'GET',
    headers,
    signal:  AbortSignal.timeout(20_000),
  });

  const raw  = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { /* not JSON */ }

  return { status: res.status, body, raw };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  // 1. Load session
  const { graphqlUrl } = loadSession();

  // 2. Build fresh URL
  const requestUrl = buildUrl(graphqlUrl, QUERY);
  console.log(`\n[url] Request URL (first 120 chars):\n  ${requestUrl.slice(0, 120)}…`);

  // 3. Get cookies
  const cookieStr = await getBraveCookies();

  // 4. Fire request
  console.log(`\n[fetch] Sending request…`);
  const t0 = Date.now();
  const { status, body, raw } = await directFetch(requestUrl, cookieStr);
  const elapsed = Date.now() - t0;

  console.log(`[fetch] HTTP ${status}  (${elapsed} ms)`);

  // ── Detect bot/challenge responses
  if (status === 403 || status === 429) {
    console.error(`\n[BLOCKED] HTTP ${status} — Walmart bot detection triggered.`);
    console.error('Direct fetch is not viable. Use attach-walmart-session.ts instead.');
    fs.writeFileSync(OUT_FILE, JSON.stringify({
      verdict: 'BLOCKED', status, requestUrl, cookieUsed: !!cookieStr, raw: raw.slice(0, 2000),
    }, null, 2));
    return;
  }

  if (typeof raw === 'string' && (
    raw.includes('AkamaiGHost') ||
    raw.includes('Robot or human') ||
    raw.includes('Access Denied') ||
    raw.includes('captcha')
  )) {
    console.error('\n[BLOCKED] Bot-challenge page returned (Akamai/CAPTCHA).');
    console.error('Direct fetch is not viable. Use attach-walmart-session.ts instead.');
    fs.writeFileSync(OUT_FILE, JSON.stringify({
      verdict: 'CAPTCHA', status, requestUrl, cookieUsed: !!cookieStr, raw: raw.slice(0, 2000),
    }, null, 2));
    return;
  }

  if (!body) {
    console.error(`\n[ERROR] Non-JSON response (status ${status}). First 500 chars:`);
    console.error(raw.slice(0, 500));
    fs.writeFileSync(OUT_FILE, JSON.stringify({
      verdict: 'NON_JSON', status, requestUrl, raw: raw.slice(0, 2000),
    }, null, 2));
    return;
  }

  // 5. Parse priced items
  const rawItems = collectPricedItems(body);
  console.log(`\n[parse] Found ${rawItems.length} priced item(s) in response`);

  const allProducts = rawItems
    .map(r => normalize(r))
    .filter((p): p is Product => p !== null);

  // 6. Filter preferred (STORE + Walmart.com + storeId 5229)
  const preferred = allProducts.filter(
    p => p.fulfillmentType === 'STORE' &&
         p.sellerName      === 'Walmart.com' &&
         p.storeIds.includes(STORE_ID),
  );

  // 7. Print
  const top10 = allProducts.slice(0, 10);

  console.log('\n' + '═'.repeat(70));
  console.log(`ALL PRODUCTS — top ${top10.length} of ${allProducts.length}`);
  console.log('═'.repeat(70));
  for (const p of top10) {
    console.log(`\n  ${p.productName}`);
    console.log(`    price          : ${p.priceString}  (${p.unitPriceString})`);
    console.log(`    usItemId       : ${p.usItemId}`);
    console.log(`    fulfillmentType: ${p.fulfillmentType}`);
    console.log(`    sellerName     : ${p.sellerName}`);
    console.log(`    storeIds       : ${p.storeIds.join(', ') || '—'}`);
    console.log(`    availability   : ${p.availabilityStatus}`);
    console.log(`    url            : ${p.canonicalUrl.slice(0, 80)}`);
  }

  console.log('\n' + '═'.repeat(70));
  console.log(`PREFERRED (STORE + Walmart.com + storeId ${STORE_ID}) — ${preferred.length} result(s)`);
  console.log('═'.repeat(70));
  if (preferred.length === 0) {
    console.log('  None. Products returned but none matched the store filter.');
    console.log('  → Check storeIds on allProducts above; store context may need cookies.');
  } else {
    const top = preferred[0];
    console.log(`\n  TOP RESULT:`);
    console.log(`    productName        : ${top.productName}`);
    console.log(`    brand              : ${top.brand}`);
    console.log(`    usItemId           : ${top.usItemId}`);
    console.log(`    offerId            : ${top.offerId}`);
    console.log(`    price              : ${top.price}`);
    console.log(`    priceString        : ${top.priceString}`);
    console.log(`    unitPriceString    : ${top.unitPriceString}`);
    console.log(`    availabilityStatus : ${top.availabilityStatus}`);
    console.log(`    fulfillmentType    : ${top.fulfillmentType}`);
    console.log(`    fulfillmentTitle   : ${top.fulfillmentTitle}`);
    console.log(`    sellerName         : ${top.sellerName}`);
    console.log(`    canonicalUrl       : ${top.canonicalUrl}`);
    console.log(`    storeIds           : ${top.storeIds.join(', ')}`);
  }

  const verdict = preferred.length > 0
    ? 'SUCCESS_STORE_PRICES'
    : allProducts.length > 0
      ? 'SUCCESS_NO_STORE_FILTER'
      : 'NO_PRODUCTS';

  console.log(`\n[verdict] ${verdict}`);

  // 8. Save
  const out = {
    verdict,
    capturedAt:   new Date().toISOString(),
    requestUrl,
    httpStatus:   status,
    elapsedMs:    elapsed,
    cookieUsed:   !!cookieStr,
    totalParsed:  allProducts.length,
    preferredCount: preferred.length,
    top10:        top10,
    preferred:    preferred,
    rawResponse:  body,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n[saved] ${OUT_FILE}`);
}

main().catch(err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
