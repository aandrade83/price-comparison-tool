/**
 * DOM-based Walmart search result extractor.
 *
 * Reads the already-rendered visible page from an attached Brave session.
 * No network interception — pure DOM scraping via page.evaluate(string).
 *
 * The evaluate body is passed as a raw string so tsx/esbuild never
 * transforms it and cannot inject __name() wrappers.
 *
 * BEFORE RUNNING:
 *   Brave must be open with Walmart search results visible.
 *   Launch with: --remote-debugging-port=9222 --remote-allow-origins=*
 *
 * RUN:
 *   npx tsx scripts/walmart-human-dom.ts
 *   npx tsx scripts/walmart-human-dom.ts "Badia Cinnamon 2 oz"
 */

import { chromium, type Page } from 'playwright';
import * as fs   from 'fs';
import * as path from 'path';

// ── Config ────────────────────────────────────────────────────────────────────

const QUERY     = process.argv[2] ?? 'Spam Classic 12 oz';
const CDP_URL   = 'http://localhost:9222';
const DEBUG_DIR = path.resolve(process.cwd(), 'debug');
const OUT_FILE  = path.join(DEBUG_DIR, 'walmart-human-dom.json');
const MAX_TILES = 20;

// ── Types (Node side only) ────────────────────────────────────────────────────

interface DomProduct {
  rank:        number;
  productName: string;
  price:       string;
  priceNum:    number | null;
  unitPrice:   string;
  brand:       string;
  productUrl:  string;
  imageUrl:    string;
  fulfillment: string;
  seller:      string;
  rawItemId:   string;
  matchScore:  number;
  bestMatch:   boolean;
}

// ── DOM extraction script ─────────────────────────────────────────────────────
// Plain JS string — esbuild never touches the contents, no __name injection.

function buildEvalScript(maxTiles: number, query: string): string {
  return `
(() => {
  const MAX   = ${maxTiles};
  const QUERY = ${JSON.stringify(query)};

  // ── helpers ─────────────────────────────────────────────────────────────────

  const getText = (el, sel) => {
    const t = sel ? (el && el.querySelector(sel)) : el;
    return ((t && t.textContent) || '').trim().replace(/\\s+/g, ' ');
  };

  const firstMatch = (el, ...sels) => {
    for (const s of sels) {
      const f = el && el.querySelector(s);
      if (f) return f;
    }
    return null;
  };

  const fuzzyScore = (name, q) => {
    const hay    = name.toLowerCase();
    const tokens = q.toLowerCase().split(/\\s+/).filter(Boolean);
    return tokens.reduce((a, t) => a + (hay.includes(t) ? 1 : 0), 0);
  };

  // ── clean price extractor ────────────────────────────────────────────────────
  // Walmart's price textContent looks like:
  //   "$414current price $4.1434.5 ¢/ozOptions from $4.14 – $79.14"
  // Strategy (in order):
  //   1. itemprop="price" content attribute  → pure numeric, most reliable
  //   2. aria-label containing "current price $X.XX"
  //   3. regex on "current price $X.XX" anywhere in tile text
  //   4. first standalone $X.XX after stripping noise

  const extractPrice = (tile) => {
    // 1. Schema.org content attribute
    const schema = tile.querySelector('[itemprop="price"]');
    if (schema) {
      const c = schema.getAttribute('content');
      if (c) {
        const n = parseFloat(c);
        if (isFinite(n) && n > 0) return { text: '\\$' + n.toFixed(2), num: n };
      }
    }

    // 2. aria-label="current price $4.14"
    const ariaEls = Array.from(tile.querySelectorAll('[aria-label]'));
    for (const el of ariaEls) {
      const lbl = el.getAttribute('aria-label') || '';
      const m   = lbl.match(/current price \\$([0-9]{1,4}\\.[0-9]{2})/i);
      if (m) return { text: '\\$' + m[1], num: parseFloat(m[1]) };
    }

    // 3. "current price $X.XX" anywhere in tile textContent
    const full = (tile.textContent || '');
    const m3   = full.match(/current price \\$([0-9]{1,4}\\.[0-9]{2})/i);
    if (m3) return { text: '\\$' + m3[1], num: parseFloat(m3[1]) };

    // 4. Strip noise, then first $X.XX (exactly 2 decimals, no trailing digits)
    //    "$414" has no decimal → won't match
    //    "$4.1434" → lookahead (?![0-9]) blocks it
    const stripped = full
      .replace(/options from[^\\n]*/gi, '')
      .replace(/[0-9]+[kK]\\+?\\s*bought[^\\n]*/gi, '');
    const m4 = stripped.match(/\\$([0-9]{1,4}\\.[0-9]{2})(?![0-9])/);
    if (m4) return { text: '\\$' + m4[1], num: parseFloat(m4[1]) };

    return { text: '', num: null };
  };

  // ── unit price extractor ─────────────────────────────────────────────────────
  // Accept only "X ¢/unit" or "X.XX/unit" patterns.
  // Reject social-proof text like "5K+ bought since yesterday".

  const extractUnitPrice = (tile) => {
    const unitEl = firstMatch(tile,
      '[data-automation-id="unit-price"]',
      '[class*="f7"][class*="gray"]',
    );
    const raw = getText(unitEl);
    if (/[¢$]\\//.test(raw)) return raw;

    // fallback: scan tile text for the pattern
    const m = (tile.textContent || '').match(/[0-9.]+\\s*[¢$]\\/\\w+/);
    return m ? m[0] : '';
  };

  // ── brand extractor ──────────────────────────────────────────────────────────
  // Priority:
  //   1. DOM brand element (if not empty)
  //   2. Leading ALL-CAPS word(s) in productName  e.g. "SPAM Classic" → "SPAM"
  //      "GREAT VALUE Rice" → "GREAT VALUE"

  const extractBrand = (productName, domBrand) => {
    if (domBrand) return domBrand;
    // Match one or more UPPER-CASE words at the start, stopping before
    // a Title-Case word (e.g. "Classic"), a digit, or a comma.
    const m = productName.match(/^((?:[A-Z][A-Z0-9]*\\s+)*[A-Z][A-Z0-9]*)(?=\\s+[A-Z][a-z]|\\s+\\d|,|$)/);
    return m ? m[1].trim() : '';
  };

  // ── find tile containers ─────────────────────────────────────────────────────

  const TILE_SELS = [
    '[data-item-id]',
    '[data-product-id]',
    '[data-automation-id="product"]',
    '[data-testid="item-stack"]',
    'section[data-automation-id]',
    '[data-testid="list-view"] > div > div',
    '.search-result-gridview-item',
    'li[data-id]',
  ];

  let tiles = [];
  for (const sel of TILE_SELS) {
    const found = Array.from(document.querySelectorAll(sel));
    if (found.length >= 3) { tiles = found; break; }
  }

  if (tiles.length === 0) {
    const links = Array.from(document.querySelectorAll('a[href*="/ip/"]'));
    const seen  = new Set();
    for (const lnk of links) {
      const anc = lnk.closest('li') || lnk.closest('[class]') || lnk.parentElement;
      if (anc && !seen.has(anc)) { seen.add(anc); tiles.push(anc); }
    }
  }

  // ── extract each tile ────────────────────────────────────────────────────────

  const rows = [];

  for (let i = 0; i < Math.min(tiles.length, MAX); i++) {
    const tile = tiles[i];

    // name
    const nameEl = firstMatch(tile,
      '[data-automation-id="product-title"]',
      '[link-identifier]',
      'a[href*="/ip/"] span',
      'span[class*="lh-title"]',
      'h2 a', 'h3 a',
    );
    const productName = getText(nameEl) || getText(tile, 'a[href*="/ip/"]');
    if (!productName) continue;

    // price
    const { text: priceText, num: priceNum } = extractPrice(tile);

    // unit price
    const unitPrice = extractUnitPrice(tile);

    // brand
    const domBrand = getText(firstMatch(tile,
      '[data-automation-id="product-brand"]',
      '[class*="brand"]',
    ));
    const brand = extractBrand(productName, domBrand);

    // URL
    const linkEl     = tile.querySelector('a[href*="/ip/"]');
    const rawHref    = (linkEl && linkEl.getAttribute('href')) || '';
    const productUrl = rawHref
      ? (rawHref.startsWith('http') ? rawHref : 'https://www.walmart.com' + rawHref)
      : '';

    // image
    const imgEl    = tile.querySelector('img[src], img[data-src]');
    const imgSrc   = (imgEl && (imgEl.getAttribute('src') || imgEl.getAttribute('data-src'))) || '';
    const imageUrl = imgSrc.split('?')[0];

    // fulfillment
    const fulfillEl = firstMatch(tile,
      '[data-automation-id="fulfillment-badge"]',
      '[class*="fulfillment"]',
      '[class*="pickup"]',
      '[class*="delivery"]',
    );
    let fulfillment = getText(fulfillEl);
    if (!fulfillment) {
      for (const kw of ['Pickup', 'Delivery', 'Shipping', 'In store']) {
        if ((tile.textContent || '').includes(kw)) { fulfillment = kw; break; }
      }
    }

    // seller
    const seller = getText(firstMatch(tile,
      '[class*="seller"]',
      '[data-automation-id="seller-name"]',
    ));

    // item id
    const urlMatch  = productUrl.match(/\\/ip\\/[^/]+\\/(\\d+)/);
    const rawItemId =
      tile.getAttribute('data-item-id') ||
      tile.getAttribute('data-product-id') ||
      (urlMatch && urlMatch[1]) || '';

    rows.push({
      rank:        i + 1,
      productName,
      price:       priceText,
      priceNum,
      unitPrice,
      brand,
      productUrl,
      imageUrl,
      fulfillment: fulfillment.trim(),
      seller:      seller.trim(),
      rawItemId,
      matchScore:  fuzzyScore(productName, QUERY),
      bestMatch:   false,
    });
  }

  // mark best match
  if (rows.length > 0) {
    const best = rows.reduce((a, b) => b.matchScore > a.matchScore ? b : a);
    if (best.matchScore > 0) best.bestMatch = true;
  }

  return rows;
})()
`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findWalmartPage(
  browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>,
): Promise<Page | null> {
  for (const ctx of browser.contexts()) {
    for (const pg of ctx.pages()) {
      if (pg.url().includes('walmart.com')) return pg;
    }
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  console.log(`\nQuery  : "${QUERY}"`);

  // 1. Connect
  console.log(`[cdp] Connecting to ${CDP_URL} …`);
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  try {
    browser = await chromium.connectOverCDP(CDP_URL, { timeout: 5_000 });
  } catch (e) {
    console.error(`[cdp] Failed: ${(e as Error).message}`);
    console.error('Launch Brave with: --remote-debugging-port=9222 --remote-allow-origins=*');
    process.exit(1);
  }
  console.log('[cdp] Connected.');

  // 2. Find Walmart tab
  let page = await findWalmartPage(browser);
  if (!page) {
    console.log('[tab] No Walmart tab — opening search URL…');
    const ctx = browser.contexts()[0];
    page      = await ctx.newPage();
    await page.goto(
      `https://www.walmart.com/search?q=${encodeURIComponent(QUERY)}`,
      { waitUntil: 'domcontentloaded', timeout: 30_000 },
    );
  } else {
    console.log(`[tab] Using: ${page.url()}`);
  }

  // 3. Wait for product tiles
  console.log('[wait] Looking for product tiles…');
  try {
    await page.waitForSelector(
      '[data-item-id], [data-product-id], a[href*="/ip/"], [data-automation-id="product"]',
      { timeout: 12_000 },
    );
    console.log('[wait] Tiles visible.');
  } catch {
    console.log('[wait] Selector timed out — attempting extraction anyway.');
  }

  // 4. Extract via raw JS string — esbuild cannot inject __name into a string literal
  console.log('[dom] Extracting product tiles…');
  const products = await page.evaluate(
    buildEvalScript(MAX_TILES, QUERY),
  ) as DomProduct[];

  // 5. Print formatted table
  console.log(`\n[dom] Extracted ${products.length} tile(s)\n`);

  if (products.length === 0) {
    console.log('No tiles found. Make sure Walmart search results are fully loaded in Brave.');
  }

  const W    = { name: 50, price: 8, unit: 14, fill: 12 };
  const pad  = (s: string, n: number) => s.slice(0, n).padEnd(n);
  const line = '─'.repeat(W.name + W.price + W.unit + W.fill + 16);

  console.log(line);
  console.log(
    `  ${'#'.padEnd(3)} ${pad('Product', W.name)} ${pad('Price', W.price)} ` +
    `${pad('Unit', W.unit)} ${pad('Fulfillment', W.fill)} Score`,
  );
  console.log(line);

  for (const p of products) {
    console.log(
      `  ${String(p.rank).padEnd(3)} ${pad(p.productName, W.name)} ` +
      `${pad(p.price, W.price)} ${pad(p.unitPrice, W.unit)} ` +
      `${pad(p.fulfillment, W.fill)} ${p.matchScore}${p.bestMatch ? ' ★' : ''}`,
    );
  }
  console.log(line);

  const best = products.find(p => p.bestMatch);
  if (best) {
    console.log(`\n★ BEST MATCH:`);
    console.log(`  Name       : ${best.productName}`);
    console.log(`  Price      : ${best.price}  (${best.unitPrice})`);
    console.log(`  Brand      : ${best.brand || '—'}`);
    console.log(`  Fulfillment: ${best.fulfillment}`);
    console.log(`  Seller     : ${best.seller}`);
    console.log(`  Item ID    : ${best.rawItemId}`);
    console.log(`  URL        : ${best.productUrl.slice(0, 80)}`);
  }

  // 6. Save
  const out = {
    capturedAt: new Date().toISOString(),
    query:      QUERY,
    pageUrl:    page.url(),
    totalTiles: products.length,
    bestMatch:  best ?? null,
    products,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n[saved] ${OUT_FILE}`);

  await browser.close();
}

main().catch(err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
