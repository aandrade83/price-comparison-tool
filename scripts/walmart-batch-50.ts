/**
 * Batch Walmart price fetch for first 50 Save A Lot products — v2
 *
 * v2 changes:
 *   • normalize() strips ®™©!, parens, FL OZ→oz, fractions, commas
 *   • buildQueries() generates up to 6 retry queries per product (A–F)
 *   • Retry loop stops at first price hit; tracks which query succeeded
 *
 * RUN:
 *   npx tsx scripts/walmart-batch-50.ts
 *
 * REQUIRES:
 *   Brave running with --remote-debugging-port=9222 --remote-allow-origins=*
 *   and already signed into Walmart with store #5229 selected.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

import { chromium, type Page }    from 'playwright';
import { drizzle }                from 'drizzle-orm/node-postgres';
import { asc, eq, and }           from 'drizzle-orm';
import { Pool }                   from 'pg';
import * as fs                    from 'fs';
import * as path                  from 'path';
import { products, competitorPrices } from '../src/db/schema';

// ── Config ────────────────────────────────────────────────────────────────────

const CDP_URL    = 'http://localhost:9222';
const STORE      = 'Walmart';
const STORE_ID   = '5229';
const ZIPCODE    = '19095';           // Wyncote PA
const SOURCE     = 'live_dom';
const DELAY_MIN  = 4_000;
const DELAY_MAX  = 8_000;
const RETRY_MS   = 1_500;            // between retry attempts for same product
const MAX_TILES  = 10;
const DEBUG_DIR  = path.resolve(process.cwd(), 'debug');
const ERR_FILE   = path.join(DEBUG_DIR, 'walmart-batch-errors.json');

// ── DB ────────────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const db = drizzle(pool, { schema: { products, competitorPrices } });

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const randDelay = () => DELAY_MIN + Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN));

function cleanUnitPrice(raw: string): string {
  const m = raw.match(/[\d.]+\s*[¢$]\/\w+/);
  return m ? m[0] : '';
}

function itemIdFromUrl(url: string): string {
  const m = url.match(/\/ip\/[^/]+\/(\d+)/);
  return m ? m[1] : '';
}

// ── Query normalizer & retry builder ─────────────────────────────────────────

const FILLERS = new Set([
  'original', 'classic', 'style', 'the', 'with', 'old', 'new', 'world',
  'pure', 'fresh', 'natural', 'loaded', 'baked', 'spray', 'cans', 'can',
  'wada', 'ever', 'wet', 'town', 'country', 'farm', 'farms', 'and', 'in',
]);

const SPANISH_COMPOUNDS: Array<[RegExp, string]> = [
  [/manzanas?\s+rojas/gi,     'red apples'],
  [/manzanas?\s+verdes/gi,    'green apples'],
  [/manzanas?\s+amarillas/gi, 'yellow apples'],
];

const SPANISH: Record<string, string> = {
  manzana: 'apple',  manzanas: 'apples',
  rojas:   'red',    rojo: 'red',   roja: 'red',
  verdes:  'green',  verde: 'green',
  amarillas: 'yellow', amarillo: 'yellow',
  jugo:    'juice',  leche: 'milk',
  frijoles:'beans',  frijol: 'bean',
  arroz:   'rice',   pollo: 'chicken',
  carne:   'beef',   cerdo: 'pork',
  limon:   'lemon',  naranja: 'orange',
  piña:    'pineapple', uvas: 'grapes', uva: 'grape',
};

function normalize(raw: string): string {
  return raw
    .replace(/[®™©!]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b\d+\s*%/g, ' ')
    .replace(/\bfl\.?\s*oz\b/gi, 'oz')
    .replace(/(\d+)\s+(\d+)\s*\/\s*(\d+)/g,
      (_, w, n, d) => (parseInt(w) + parseInt(n) / parseInt(d)).toFixed(2))
    .replace(/\b(\d+)\s*\/\s*(\d+)\b/g,
      (_, n, d) => (parseInt(n) / parseInt(d)).toFixed(2))
    .replace(/,/g, ' ')
    .replace(/&/g, 'and')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildQueries(rawName: string, brand: string | null, size: string | null): string[] {
  const q: string[] = [];
  const norm = normalize(rawName);

  // A — normalized full name
  q.push(norm);

  // B — inject DB brand, skipping the same number of leading tokens as brand has words
  //     handles "BARS COTTO SALAMI 16 OZ" + brand "Bar-S" → "Bar-S COTTO SALAMI 16 OZ"
  if (brand) {
    const brandWordCount = brand.trim().split(/\s+/).length;
    const rest  = norm.split(' ').slice(brandWordCount).join(' ');
    const fixed = `${brand} ${rest}`.trim();
    if (fixed.toLowerCase() !== norm.toLowerCase()) q.push(fixed);
  }

  // C — strip filler/noise words; append DB size if not already present
  const stripped = norm
    .split(' ')
    .filter(w => !FILLERS.has(w.toLowerCase()))
    .join(' ')
    .trim();

  if (stripped.length > 0 && stripped !== norm) {
    q.push(stripped);
    if (size) {
      const ns = normalize(size);
      if (!stripped.toLowerCase().includes(ns.toLowerCase().split(' ')[0])) {
        q.push(`${stripped} ${ns}`.trim());
      }
    }
  } else if (size) {
    const ns       = normalize(size);
    const noFiller = norm.split(' ').filter(w => !FILLERS.has(w.toLowerCase())).join(' ');
    if (!noFiller.toLowerCase().includes(ns.toLowerCase().split(' ')[0])) {
      q.push(`${noFiller} ${ns}`.trim());
    }
  }

  // D — Spanish → English translation
  let xlated = norm;
  for (const [pat, en] of SPANISH_COMPOUNDS) xlated = xlated.replace(pat, en);
  for (const [es, en] of Object.entries(SPANISH)) {
    xlated = xlated.replace(new RegExp(`\\b${es}\\b`, 'gi'), en);
  }
  if (xlated.toLowerCase() !== norm.toLowerCase()) q.push(xlated);

  // E — prefix up to first filler word + size
  //     "I Can't Believe It's Not Butter The Original Vegetable Oil Spread 15 Oz"
  //     → "I Can't Believe It's Not Butter 15 Oz"
  const words   = norm.split(' ');
  const stopIdx = words.findIndex(w => FILLERS.has(w.toLowerCase()));
  if (stopIdx > 2) {
    const prefix    = words.slice(0, stopIdx).join(' ');
    const sizeInName = norm.match(/\d+\.?\d*\s*(?:oz|lb|lbs|g|ml|ct|pk)\b/i)?.[0] ?? '';
    const sizeStr   = size ? normalize(size) : sizeInName;
    const candidate = sizeStr ? `${prefix} ${sizeStr}`.trim() : prefix;
    if (candidate.toLowerCase() !== norm.toLowerCase() && candidate.length > 0) q.push(candidate);
  }

  // F — brand + size only (last resort)
  if (brand && size) {
    const f = `${brand} ${normalize(size)}`.trim();
    if (f.toLowerCase() !== norm.toLowerCase()) q.push(f);
  }

  return [...new Set(q.filter(Boolean))];
}

// ── DOM extraction (same engine as walmart-human-dom.ts) ─────────────────────
// Passed as a raw string so esbuild never injects __name().

function buildEvalScript(maxTiles: number, query: string): string {
  return `
(() => {
  const MAX   = ${maxTiles};
  const QUERY = ${JSON.stringify(query)};

  const getText = (el, sel) => {
    const t = sel ? (el && el.querySelector(sel)) : el;
    return ((t && t.textContent) || '').trim().replace(/\\s+/g, ' ');
  };

  const firstMatch = (el, ...sels) => {
    for (const s of sels) { const f = el && el.querySelector(s); if (f) return f; }
    return null;
  };

  const fuzzyScore = (name, q) => {
    const hay = name.toLowerCase();
    return q.toLowerCase().split(/\\s+/).filter(Boolean)
      .reduce((a, t) => a + (hay.includes(t) ? 1 : 0), 0);
  };

  const extractPrice = (tile) => {
    const schema = tile.querySelector('[itemprop="price"]');
    if (schema) {
      const c = schema.getAttribute('content');
      if (c) { const n = parseFloat(c); if (isFinite(n) && n > 0) return { text: '\\$' + n.toFixed(2), num: n }; }
    }
    const ariaEls = Array.from(tile.querySelectorAll('[aria-label]'));
    for (const el of ariaEls) {
      const lbl = el.getAttribute('aria-label') || '';
      const m   = lbl.match(/current price \\$([0-9]{1,4}\\.[0-9]{2})/i);
      if (m) return { text: '\\$' + m[1], num: parseFloat(m[1]) };
    }
    const full = tile.textContent || '';
    const m3   = full.match(/current price \\$([0-9]{1,4}\\.[0-9]{2})/i);
    if (m3) return { text: '\\$' + m3[1], num: parseFloat(m3[1]) };
    const stripped = full
      .replace(/options from[^\\n]*/gi, '')
      .replace(/[0-9]+[kK]\\+?\\s*bought[^\\n]*/gi, '');
    const m4 = stripped.match(/\\$([0-9]{1,4}\\.[0-9]{2})(?![0-9])/);
    if (m4) return { text: '\\$' + m4[1], num: parseFloat(m4[1]) };
    return { text: '', num: null };
  };

  const extractUnitPrice = (tile) => {
    const unitEl = firstMatch(tile, '[data-automation-id="unit-price"]', '[class*="f7"][class*="gray"]');
    const raw    = getText(unitEl);
    if (/[¢$]\\//.test(raw)) return raw;
    const m = (tile.textContent || '').match(/[0-9.]+\\s*[¢$]\\/\\w+/);
    return m ? m[0] : '';
  };

  const extractBrand = (name, dom) => {
    if (dom) return dom;
    const m = name.match(/^((?:[A-Z][A-Z0-9]*\\s+)*[A-Z][A-Z0-9]*)(?=\\s+[A-Z][a-z]|\\s+\\d|,|$)/);
    return m ? m[1].trim() : '';
  };

  const TILE_SELS = [
    '[data-item-id]', '[data-product-id]', '[data-automation-id="product"]',
    '[data-testid="item-stack"]', 'section[data-automation-id]',
    '[data-testid="list-view"] > div > div', 'li[data-id]',
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

  const rows = [];
  for (let i = 0; i < Math.min(tiles.length, MAX); i++) {
    const tile = tiles[i];
    const nameEl = firstMatch(tile,
      '[data-automation-id="product-title"]', '[link-identifier]',
      'a[href*="/ip/"] span', 'span[class*="lh-title"]', 'h2 a', 'h3 a',
    );
    const productName = getText(nameEl) || getText(tile, 'a[href*="/ip/"]');
    if (!productName) continue;

    const { text: priceText, num: priceNum } = extractPrice(tile);
    const unitPrice = extractUnitPrice(tile);
    const domBrand  = getText(firstMatch(tile, '[data-automation-id="product-brand"]', '[class*="brand"]'));
    const brand     = extractBrand(productName, domBrand);

    const linkEl     = tile.querySelector('a[href*="/ip/"]');
    const rawHref    = (linkEl && linkEl.getAttribute('href')) || '';
    const productUrl = rawHref
      ? (rawHref.startsWith('http') ? rawHref : 'https://www.walmart.com' + rawHref)
      : '';

    let fulfillment = '';
    const fulfillEl = firstMatch(tile,
      '[data-automation-id="fulfillment-badge"]', '[class*="fulfillment"]',
      '[class*="pickup"]', '[class*="delivery"]',
    );
    fulfillment = getText(fulfillEl);
    if (!fulfillment) {
      for (const kw of ['Pickup', 'Delivery', 'Shipping', 'In store']) {
        if ((tile.textContent || '').includes(kw)) { fulfillment = kw; break; }
      }
    }

    const urlMatch  = productUrl.match(/\\/ip\\/[^/]+\\/(\\d+)/);
    const rawItemId =
      tile.getAttribute('data-item-id') ||
      tile.getAttribute('data-product-id') ||
      (urlMatch && urlMatch[1]) || '';

    rows.push({
      productName, priceText, priceNum,
      unitPrice, brand, productUrl, fulfillment, rawItemId,
      matchScore: fuzzyScore(productName, QUERY),
    });
  }

  if (rows.length === 0) return null;
  const best = rows.reduce((a, b) => b.matchScore > a.matchScore ? b : a);
  return best.matchScore > 0 ? best : rows[0];
})()
`;
}

// ── Result type from browser ──────────────────────────────────────────────────

interface BestMatch {
  productName: string;
  priceText:   string;
  priceNum:    number | null;
  unitPrice:   string;
  brand:       string;
  productUrl:  string;
  fulfillment: string;
  rawItemId:   string;
  matchScore:  number;
}

// ── Search one product via DOM ────────────────────────────────────────────────

async function searchOne(page: Page, productName: string): Promise<BestMatch | null> {
  const searchUrl = `https://www.walmart.com/search?q=${encodeURIComponent(productName)}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  try {
    await page.waitForSelector(
      '[data-item-id], [data-product-id], a[href*="/ip/"], [data-automation-id="product"]',
      { timeout: 12_000 },
    );
  } catch {
    // page may have loaded without matching selector — try anyway
  }

  await sleep(1_200);

  return page.evaluate(buildEvalScript(MAX_TILES, productName)) as Promise<BestMatch | null>;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — check .env.local');
    process.exit(1);
  }

  // 1. Connect CDP
  console.log(`\n[cdp] Connecting to ${CDP_URL} …`);
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  try {
    browser = await chromium.connectOverCDP(CDP_URL, { timeout: 5_000 });
  } catch (e) {
    console.error(`[cdp] Failed: ${(e as Error).message}`);
    console.error('Launch Brave with: --remote-debugging-port=9222 --remote-allow-origins=*');
    process.exit(1);
  }
  console.log('[cdp] Connected.');

  // 2. Find or open Walmart tab
  let walmartPage: Page | null = null;
  for (const ctx of browser.contexts()) {
    for (const pg of ctx.pages()) {
      if (pg.url().includes('walmart.com')) { walmartPage = pg; break; }
    }
    if (walmartPage) break;
  }

  if (!walmartPage) {
    console.log('[tab] No Walmart tab found — opening one…');
    const ctx = browser.contexts()[0];
    walmartPage = await ctx.newPage();
    await walmartPage.goto('https://www.walmart.com', { waitUntil: 'domcontentloaded', timeout: 20_000 });
  } else {
    console.log(`[tab] Using: ${walmartPage.url()}`);
  }

  // 3. Load products (now includes brand for query-B substitution)
  const rows = await db
    .select({ id: products.id, name: products.name, brand: products.brand, size: products.size })
    .from(products)
    .orderBy(asc(products.id))
    .limit(50);

  const total = rows.length;
  console.log(`\n[db] ${total} products to process\n`);
  console.log(`Store  : Walmart #${STORE_ID} — Wyncote PA ${ZIPCODE}`);
  console.log(`Delays : ${DELAY_MIN / 1000}–${DELAY_MAX / 1000}s between products, ${RETRY_MS / 1000}s between retries`);
  console.log('─'.repeat(72));

  // 4. Batch loop
  let inserted = 0;
  let skipped  = 0;
  let failed   = 0;
  const errors: Array<{ productId: number; name: string; error: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const product = rows[i];
    const idx     = i + 1;
    const label   = product.name.slice(0, 46).padEnd(46);
    process.stdout.write(`[${String(idx).padStart(2)}/${total}] ${label} `);

    try {
      const queries = buildQueries(product.name, product.brand ?? null, product.size ?? null);
      let match: BestMatch | null = null;
      let attemptLabel = 'A';

      for (let a = 0; a < queries.length; a++) {
        if (a > 0) await sleep(RETRY_MS);

        try {
          const result = await searchOne(walmartPage, queries[a]);
          if (result && result.priceNum !== null) {
            match        = result;
            attemptLabel = 'ABCDEF'[a] ?? String(a);
            break;
          }
        } catch (err) {
          if (a === queries.length - 1) throw err;
          // otherwise fall through to next query
        }
      }

      if (!match || match.priceNum === null) {
        const tried = queries.slice(0, 6).map((_, a) => 'ABCDEF'[a]).join('');
        console.log(`→ no price  [tried ${tried}]`);
        skipped++;
      } else {
        await db
          .delete(competitorPrices)
          .where(
            and(
              eq(competitorPrices.productId, product.id),
              eq(competitorPrices.store, STORE),
            ),
          );

        const usItemId  = itemIdFromUrl(match.productUrl) || match.rawItemId;
        const unitClean = cleanUnitPrice(match.unitPrice);

        await db.insert(competitorPrices).values({
          productId:   product.id,
          store:       STORE,
          zipcode:     ZIPCODE,
          matchedName: match.productName,
          price:       String(match.priceNum),
          size:        unitClean || null,
          url:         match.productUrl || null,
          source:      SOURCE,
        });

        const via = attemptLabel !== 'A' ? ` [via ${attemptLabel}]` : '';
        console.log(
          `→ ${match.priceText.padStart(6)}  ` +
          `[${match.fulfillment || '?'}]  ` +
          `${match.productName.slice(0, 28)}` +
          (usItemId ? `  #${usItemId}` : '') +
          via,
        );
        inserted++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`→ ERROR: ${msg.slice(0, 55)}`);
      errors.push({ productId: product.id, name: product.name, error: msg });
      failed++;
    }

    if (idx < total) await sleep(randDelay());
  }

  // 5. Summary
  console.log('\n' + '─'.repeat(72));
  console.log(`Done.  inserted: ${inserted}  skipped: ${skipped}  errors: ${failed}`);

  if (errors.length > 0) {
    fs.writeFileSync(ERR_FILE, JSON.stringify(errors, null, 2), 'utf8');
    console.log(`\nErrors saved to: ${ERR_FILE}`);
  }

  await browser.close();
  await pool.end();
}

main().catch(async err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err);
  await pool.end();
  process.exit(1);
});
