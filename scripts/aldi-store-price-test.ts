/**
 * Aldi Store Price Architecture Test
 *
 * Determines:
 *   1. Whether prices are accessible via plain Node.js fetch
 *   2. Whether prices vary by store/ZIP (store-specific vs national)
 *   3. Anti-bot protection level
 *   4. Best technical path for PRICEODDS Aldi integration
 *
 * Method:
 *   Phase A: Direct Node.js fetch with full browser headers
 *   Phase B: Playwright CDP fallback (attach to existing Brave session)
 *   Price extraction from SSR HTML or __NEXT_DATA__ JSON
 *
 * RUN:
 *   npx tsx scripts/aldi-store-price-test.ts
 *
 * REQUIRES (Phase B only, optional):
 *   Brave running with --remote-debugging-port=9222 --remote-allow-origins=*
 */

import * as fs   from 'fs';
import * as path from 'path';

const DEBUG_DIR = path.resolve(process.cwd(), 'debug');
const OUT_FILE  = path.join(DEBUG_DIR, 'aldi-store-price-test.json');
const CDP_URL   = 'http://localhost:9222';

// ── Test stores (from aldi-stores-19138.json nearest results) ────────────────

const STORES = [
  {
    rank:    1,
    label:   '#1 Philadelphia (nearest)',
    address: '6119 North Broad Street, Philadelphia PA 19141',
    zip:     '19141',
  },
  {
    rank:    2,
    label:   '#2 Philadelphia',
    address: '5200 Whiteaker Avenue, Philadelphia PA 19124',
    zip:     '19124',
  },
  {
    rank:    3,
    label:   '#3 Willow Grove',
    address: '1955 Davisville Road, Willow Grove PA 19090',
    zip:     '19090',
  },
];

// Demo-zone reference ZIP for comparison
const DEMO_ZIP = '19138';

// ── Test products ─────────────────────────────────────────────────────────────

const PRODUCTS = ['milk', 'eggs', 'bread', 'butter', 'cheese', 'banana', 'chicken'];

// ── Instacart/Aldi URL builder ────────────────────────────────────────────────

function storefrontUrl(postalCode: string): string {
  return `https://www.instacart.com/store/aldi/storefront?postal_code=${postalCode}`;
}

function searchUrl(query: string, postalCode: string): string {
  return `https://www.instacart.com/store/aldi/storefront?q=${encodeURIComponent(query)}&postal_code=${postalCode}`;
}

// ── Full browser-like request headers ────────────────────────────────────────

const BROWSER_HEADERS: Record<string, string> = {
  'accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language':           'en-US,en;q=0.9',
  'accept-encoding':           'gzip, deflate, br',
  'user-agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'sec-ch-ua':                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile':         '?0',
  'sec-ch-ua-platform':       '"Windows"',
  'sec-fetch-dest':            'document',
  'sec-fetch-mode':            'navigate',
  'sec-fetch-site':            'none',
  'upgrade-insecure-requests': '1',
  'cache-control':             'max-age=0',
};

// ── HTML / JSON extraction helpers ────────────────────────────────────────────

/** Detect bot-challenge responses (DataDome, Cloudflare, etc.) */
function isBotChallenge(html: string): { blocked: boolean; service: string } {
  if (html.includes('datadome'))         return { blocked: true,  service: 'DataDome' };
  if (html.includes('cf-browser-check')) return { blocked: true,  service: 'Cloudflare' };
  if (html.includes('PerimeterX'))       return { blocked: true,  service: 'PerimeterX' };
  if (html.includes('Robot or human'))   return { blocked: true,  service: 'Akamai' };
  if (html.includes('<title>Access'))    return { blocked: true,  service: 'Generic WAF' };
  if (html.length < 1_000)              return { blocked: true,  service: 'Empty/tiny response' };
  return { blocked: false, service: 'none' };
}

/**
 * Parse product tiles from Instacart SSR HTML.
 *
 * The page embeds accessibility text like:
 *   <span class="screen-reader-only">Current price: $3.19</span>
 * followed later by:
 *   <div ... role="heading" aria-level="3">Friendly Farms Whole Milk</div>
 *
 * Product name headings always appear after the price in the tile markup,
 * so we scan each heading then look backward ≤2000 chars for the last
 * "Current price: $X.XX" before it.
 */
function parseProductsFromHtml(html: string): Array<{ name: string; price: string }> {
  const results: Array<{ name: string; price: string }> = [];
  const headingRe = /aria-level="3">([^<]+)</g;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(html)) !== null) {
    const name = m[1]
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g,  '&')
      .replace(/&lt;/g,   '<')
      .replace(/&gt;/g,   '>')
      .trim();
    // Look backward for the most recent "Current price: $X.XX"
    const lookback = html.slice(Math.max(0, m.index - 2000), m.index);
    const priceMatch = lookback.match(/Current price: (\$[\d.]+)(?![\s\S]*Current price:)/);
    if (priceMatch) {
      results.push({ name, price: priceMatch[1] });
    }
  }
  return results;
}

/** Find the first product whose name contains the keyword */
function findProduct(
  items:   Array<{ name: string; price: string }>,
  keyword: string,
): { name: string; price: string } | null {
  const kw = keyword.toLowerCase();
  return items.find(it => it.name.toLowerCase().includes(kw)) ?? null;
}

// ── Phase A: Direct Node.js fetch ─────────────────────────────────────────────

async function fetchDirect(url: string): Promise<{
  ok:        boolean;
  status:    number;
  html:      string;
  blocked:   boolean;
  blocker:   string;
  elapsed:   number;
}> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal:  AbortSignal.timeout(20_000),
      redirect: 'follow',
    });
    const html    = await res.text();
    const elapsed = Date.now() - t0;
    const { blocked, service: blocker } = isBotChallenge(html);
    return { ok: res.ok, status: res.status, html, blocked, blocker, elapsed };
  } catch (err) {
    return {
      ok: false, status: 0,
      html: '',
      blocked: true,
      blocker: `Network error: ${(err as Error).message}`,
      elapsed: Date.now() - t0,
    };
  }
}

// ── Phase B: Playwright DOM extraction via CDP ────────────────────────────────

async function fetchViaPlaywright(url: string): Promise<{
  ok:      boolean;
  html:    string;
  elapsed: number;
}> {
  // Dynamic import so the script doesn't crash if playwright isn't available
  // and Phase A already succeeded
  const { chromium } = await import('playwright');
  const t0 = Date.now();

  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  let launched = false;

  try {
    // Try attached Brave first
    browser = await chromium.connectOverCDP(CDP_URL, { timeout: 4_000 });
    console.log('  [cdp] Attached to existing Brave session');
  } catch {
    // Fall back to launching headless Chromium
    console.log('  [cdp] Brave not found — launching headless Chromium');
    browser = await chromium.launch({ headless: true }) as never;
    launched = true;
  }

  try {
    const ctx  = browser.contexts()[0] ?? await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Wait for product tiles to appear
    await page.waitForSelector('[data-testid], [class*="item"], [class*="product"]', {
      timeout: 10_000,
    }).catch(() => { /* ok if times out */ });

    const html = await page.content();
    await page.close();
    return { ok: true, html, elapsed: Date.now() - t0 };
  } finally {
    if (launched) await browser.close();
    else           await browser.close(); // disconnect from CDP
  }
}

// ── Price lookup for one product via one method ───────────────────────────────

async function lookupProduct(
  product: string,
  zip:     string,
  method:  'direct' | 'playwright',
): Promise<{
  product:  string;
  zip:      string;
  found:    boolean;
  name:     string;
  price:    string;
  unit:     string;
  method:   string;
  source:   string;
}> {
  const url = searchUrl(product, zip);
  const empty = { product, zip, found: false, name: '', price: '', unit: '', method, source: '' };

  let html = '';
  if (method === 'direct') {
    const r = await fetchDirect(url);
    if (r.blocked || !r.ok) return empty;
    html = r.html;
  } else {
    const r = await fetchViaPlaywright(url);
    if (!r.ok) return empty;
    html = r.html;
  }

  const items = parseProductsFromHtml(html);
  const match = findProduct(items, product);
  if (match) {
    return {
      product, zip, found: true,
      name: match.name, price: match.price, unit: '',
      method, source: 'html_heading',
    };
  }

  return empty;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  ALDI STORE PRICE ARCHITECTURE TEST');
  console.log('  Demo zone: 6301 Chew Ave, ZIP 19138, Philadelphia PA');
  console.log('════════════════════════════════════════════════════════════');

  // ── Phase A: Test direct fetch viability ──────────────────────────────────
  console.log('\n[Phase A] Testing direct Node.js fetch on Aldi/Instacart storefront...');

  const probeUrl = storefrontUrl(DEMO_ZIP);
  const probe    = await fetchDirect(probeUrl);

  let directFetchWorks = false;
  const antiBotLevel: string[] = [];

  if (probe.blocked) {
    console.log(`  ✗ BLOCKED by ${probe.blocker}  (HTTP ${probe.status}, ${probe.elapsed}ms)`);
    antiBotLevel.push(`Blocked: ${probe.blocker}`);
  } else if (!probe.ok) {
    console.log(`  ✗ HTTP ${probe.status}  (${probe.elapsed}ms)`);
    antiBotLevel.push(`HTTP error: ${probe.status}`);
  } else {
    const probeProducts = parseProductsFromHtml(probe.html);
    if (probeProducts.length > 0) {
      directFetchWorks = true;
      console.log(`  ✓ DIRECT FETCH WORKS — ${probeProducts.length} products parsed from SSR HTML (${probe.elapsed}ms)`);
      antiBotLevel.push('None detected — direct fetch viable');
    } else {
      const hasPrices = /\$\d+\.\d{2}/.test(probe.html);
      if (hasPrices) {
        directFetchWorks = true;
        console.log(`  ✓ Direct fetch returned HTML with prices (${probe.elapsed}ms) — parsing may need adjustment`);
        antiBotLevel.push('Light — HTML accessible');
      } else {
        console.log(`  ~ HTML returned but no prices detected — may be a soft bot challenge (${probe.elapsed}ms)`);
        antiBotLevel.push('Unknown — HTML returned but prices not found');
      }
    }
  }

  const method: 'direct' | 'playwright' = directFetchWorks ? 'direct' : 'playwright';
  if (method === 'playwright') {
    console.log('\n[Phase B] Falling back to Playwright (browser automation)...');
  }

  // ── Price testing across 3 stores ─────────────────────────────────────────
  console.log('\n[test] Fetching prices for each store × product combination...');
  console.log('       (This tests whether prices differ by ZIP / store location)\n');

  type StoreResult = {
    rank:    number;
    label:   string;
    address: string;
    zip:     string;
    prices:  Record<string, { found: boolean; name: string; price: string; unit: string; source: string }>;
  };

  const storeResults: StoreResult[] = [];

  for (const store of STORES) {
    console.log(`\n  ${store.label}`);
    console.log(`  ${store.address}`);
    console.log('  ' + '─'.repeat(52));

    const storePrices: StoreResult['prices'] = {};

    for (const product of PRODUCTS) {
      const r = await lookupProduct(product, store.zip, method);
      storePrices[product] = {
        found:  r.found,
        name:   r.name,
        price:  r.price,
        unit:   r.unit,
        source: r.source,
      };

      const status = r.found
        ? `${r.price.padStart(7)}  ${r.name.slice(0, 40)}`
        : 'not found / no public price';
      console.log(`  ${product.padEnd(10)} = ${status}`);
    }

    storeResults.push({ ...store, prices: storePrices });
  }

  // ── Analyse price consistency ─────────────────────────────────────────────
  console.log('\n\n════════════════════════════════════════════════════════════');
  console.log('  PRICE CONSISTENCY ANALYSIS');
  console.log('════════════════════════════════════════════════════════════\n');

  type PricingVerdict = 'STORE_SPECIFIC' | 'REGIONAL' | 'NATIONAL' | 'NOT_AVAILABLE' | 'INSUFFICIENT_DATA';

  let priceDiffs = 0;
  let priceSames = 0;
  let notFound   = 0;

  for (const product of PRODUCTS) {
    const vals = storeResults
      .map(s => s.prices[product])
      .filter(p => p.found && p.price);

    if (vals.length === 0) {
      notFound++;
      console.log(`  ${product.padEnd(10)}: no data`);
      continue;
    }

    const prices    = vals.map(v => v.price);
    const unique    = new Set(prices);
    const allSame   = unique.size === 1;
    const indicator = allSame ? '= same' : '≠ DIFFERS';

    if (allSame) priceSames++;
    else         priceDiffs++;

    console.log(`  ${product.padEnd(10)}: ${prices.join(' | ').padEnd(30)}  ${indicator}`);
  }

  let pricingVerdict: PricingVerdict;
  let verdictLabel: string;

  if (priceSames + priceDiffs === 0) {
    pricingVerdict = 'NOT_AVAILABLE';
    verdictLabel   = 'D) No public pricing available';
  } else if (priceDiffs === 0 && priceSames >= 2) {
    pricingVerdict = 'NATIONAL';
    verdictLabel   = 'C) Static national pricing — all stores show identical prices';
  } else if (priceDiffs > 0 && priceDiffs < priceSames) {
    pricingVerdict = 'REGIONAL';
    verdictLabel   = 'B) Regional pricing — some variation detected';
  } else if (priceDiffs >= priceSames) {
    pricingVerdict = 'STORE_SPECIFIC';
    verdictLabel   = 'A) Store-specific pricing';
  } else {
    pricingVerdict = 'INSUFFICIENT_DATA';
    verdictLabel   = 'Insufficient data — increase test coverage';
  }

  // ── Technical path verdict ─────────────────────────────────────────────────
  let techPath: string;
  let techExplanation: string;

  if (directFetchWorks) {
    techPath        = 'Direct Node.js fetch → SSR HTML parsing';
    techExplanation =
      'Aldi/Instacart storefront is server-side rendered with prices in the initial HTML. ' +
      'No browser required. Fetch with browser-like headers + parse SSR HTML: ' +
      'product names appear in aria-level="3" headings; prices appear in ' +
      'screen-reader-only spans ("Current price: $X.XX") just before each name. ' +
      'No CDP/Playwright dependency. Fast and simple.';
  } else {
    techPath        = 'Playwright browser automation (CDP or headless Chromium)';
    techExplanation =
      'Instacart blocks plain Node.js fetch (DataDome or similar). ' +
      'Must use Playwright to render the page in a real browser. ' +
      'Can reuse the existing Brave CDP pattern from the Walmart scraper. ' +
      'Slightly slower but same pattern already proven in this project.';
  }

  if (pricingVerdict === 'NATIONAL') {
    techExplanation +=
      ' Since pricing is NATIONAL, one fetch per product is enough — ' +
      'no need to switch stores or manage store context.';
  }

  // ── Final console report ───────────────────────────────────────────────────
  console.log('\n\n════════════════════════════════════════════════════════════');
  console.log('  FINAL VERDICT');
  console.log('════════════════════════════════════════════════════════════\n');

  console.log(`  Pricing model:   ${verdictLabel}`);
  console.log(`  Anti-bot level:  ${antiBotLevel.join('; ')}`);
  console.log(`  Direct fetch:    ${directFetchWorks ? '✓ WORKS' : '✗ BLOCKED'}`);
  console.log(`  Method used:     ${method}`);

  console.log('\n  Recommended technical path for PRICEODDS:');
  console.log(`  → ${techPath}`);
  console.log(`\n  ${techExplanation}`);

  console.log('\n  Price counts:');
  console.log(`    Same across all stores:    ${priceSames}`);
  console.log(`    Different across stores:   ${priceDiffs}`);
  console.log(`    Not found / no public data: ${notFound}`);

  // ── Save JSON ──────────────────────────────────────────────────────────────
  const output = {
    testedAt:          new Date().toISOString(),
    demoZip:           DEMO_ZIP,
    directFetchWorks,
    antiBotLevel,
    methodUsed:        method,
    pricingVerdict,
    verdictLabel,
    recommendedPath:   techPath,
    techExplanation,
    priceSames,
    priceDiffs,
    notFound,
    storeResults,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n[saved] ${OUT_FILE}\n`);
}

main().catch(err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
