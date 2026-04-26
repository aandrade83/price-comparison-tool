/**
 * Batch Aldi price fetch for all products in the DB.
 *
 * Architecture (confirmed by aldi-store-price-test.ts):
 *   • Aldi uses national/static pricing — one search per product, no store context needed
 *   • Instacart's SSR only renders the storefront featured items; actual search results
 *     require JavaScript execution, so this script uses Playwright (CDP attached to Brave)
 *   • Extraction: aria-level="3" headings (product names) + preceding
 *     "Current price: $X.XX" screen-reader spans
 *
 * REQUIRES:
 *   Brave running with --remote-debugging-port=9222 --remote-allow-origins=*
 *
 * Match strategy per product:
 *   A) Core noun (e.g. "potato", "milk")
 *   B) Brand + core noun (e.g. "Friendly Farms milk")
 *   C) Full normalized name
 *
 * RUN:
 *   npx tsx scripts/aldi-batch-prices.ts
 *
 * OUTPUT:
 *   Upserts into competitor_prices (store='Aldi')
 *   Console table + debug/aldi-batch-prices.json
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

import { chromium }  from 'playwright';
import { drizzle }   from 'drizzle-orm/node-postgres';
import { asc, eq, and } from 'drizzle-orm';
import { Pool }      from 'pg';
import * as fs       from 'fs';
import * as path     from 'path';
import { products, competitorPrices } from '../src/db/schema';

// ── Config ─────────────────────────────────────────────────────────────────────

const CDP_URL    = 'http://localhost:9222';
const STORE      = 'Aldi';
const ZIPCODE    = '19138';          // Demo zone: 6301 Chew Ave, Philadelphia PA
const SOURCE     = 'instacart_dom';
const DELAY_MIN  = 3_000;
const DELAY_MAX  = 6_000;
const RETRY_MS   = 1_500;

const DEBUG_DIR  = path.resolve(process.cwd(), 'debug');
const OUT_FILE   = path.join(DEBUG_DIR, 'aldi-batch-prices.json');

const BASE_URL   = 'https://www.instacart.com/store/aldi/storefront';

// ── DB ─────────────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const db = drizzle(pool, { schema: { products, competitorPrices } });

// ── Helpers ─────────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function randDelay() { return DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN); }

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'and', 'with', 'for', 'by',
  'oz', 'lb', 'lbs', 'g', 'ml', 'ct', 'pk', 'fl',
  'original', 'classic', 'style', 'new', 'old', 'world', 'pure',
  'fresh', 'natural', 'best', 'great', 'value', 'premium', 'loaded',
  'can', 'bag', 'box', 'jar', 'jug', 'tub',
  // Generic descriptors that appear in brand names / company names
  'farm', 'farms', 'town', 'country', 'golden', 'happy', 'friendly',
  'brand', 'brands', 'company', 'corp', 'inc',
]);

function normalize(s: string): string {
  return s
    .replace(/[®™©!]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/(\d+)\s+(\d+)\/(\d+)/g, (_, w, n, d) =>
      String(parseFloat(w) + parseFloat(n) / parseFloat(d)))
    .replace(/\bFL\.?\s*OZ\b/gi, 'oz')
    .replace(/,/g, '')
    .replace(/&/g, 'and')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract the most descriptive product noun (not brand, not size) */
function coreWords(name: string, brand: string | null): string[] {
  let text = normalize(name).toLowerCase();
  if (brand) {
    const nb = brand.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
    nb.split(/\s+/).filter(t => t.length >= 3).forEach(t => {
      text = text.replace(new RegExp(`\\b${t}\\b`, 'gi'), ' ');
    });
  }
  text = text.replace(/\d+\.?\d*\s*(?:oz|lb|lbs?|g|ml|ct|pk|fl)\b/gi, ' ');
  return text.split(/\s+/).filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

/** Build 1–3 search queries, most specific first */
function buildQueries(name: string, brand: string | null, size: string | null): string[] {
  const words = coreWords(name, brand);
  const queries: string[] = [];

  // A: primary core noun (single most meaningful word)
  if (words.length > 0) queries.push(words[0]);

  // B: top 2 core words (more context)
  if (words.length >= 2) {
    const q = words.slice(0, 2).join(' ');
    if (!queries.includes(q)) queries.push(q);
  }

  // C: full normalized name as fallback
  const norm = normalize(name);
  if (!queries.some(q => norm.startsWith(q)) && !queries.includes(norm)) {
    queries.push(norm);
  }

  return queries;
}

// ── HTML extraction ─────────────────────────────────────────────────────────────

interface ParsedProduct { name: string; price: string; url: string }

function parseProductsFromHtml(html: string): ParsedProduct[] {
  const results: ParsedProduct[] = [];
  const headingRe = /aria-level="3">([^<]+)</g;
  let m: RegExpExecArray | null;

  while ((m = headingRe.exec(html)) !== null) {
    const name = m[1]
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g,  '&')
      .replace(/&lt;/g,   '<')
      .replace(/&gt;/g,   '>')
      .trim();

    // Look backward for the most recent "Current price: $X.XX" before this heading
    const lookback = html.slice(Math.max(0, m.index - 2000), m.index);
    const priceMatch = lookback.match(/Current price: (\$[\d.]+)(?![\s\S]*Current price:)/);
    if (!priceMatch) continue;

    // Extract product URL from the nearby anchor (look backward)
    const urlMatch = lookback.match(/href="(\/store\/aldi\/products\/[^"]+)"(?![\s\S]*href="\/store\/aldi\/products\/)/);
    const url = urlMatch
      ? `https://www.instacart.com${urlMatch[1]}`
      : BASE_URL;

    results.push({ name, price: priceMatch[1], url });
  }

  return results;
}

/**
 * Find the best matching product.
 * The primary core word MUST appear in the product name.
 * Score additional matches for secondary core words.
 */
function findBestMatch(
  items:   ParsedProduct[],
  salName: string,
  brand:   string | null,
): ParsedProduct | null {
  const words = coreWords(salName, brand);
  if (words.length === 0) return null;

  const primaryWord = words[0];

  let bestScore = 0;
  let bestItem: ParsedProduct | null = null;

  for (const item of items) {
    const iName = item.name.toLowerCase();

    // Primary core word must be present (plural/singular tolerance)
    const primaryOk =
      iName.includes(primaryWord) ||
      (primaryWord.endsWith('s') && iName.includes(primaryWord.slice(0, -1))) ||
      (!primaryWord.endsWith('s') && iName.includes(primaryWord + 's'));

    if (!primaryOk) continue;

    let score = 1; // primary word match

    // Secondary word matches
    for (const w of words.slice(1)) {
      if (iName.includes(w) ||
          (w.endsWith('s') && iName.includes(w.slice(0, -1))) ||
          (!w.endsWith('s') && iName.includes(w + 's'))) {
        score++;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestItem  = item;
    }
  }

  return bestItem;
}

// ── DOM scraping via Playwright ────────────────────────────────────────────────

async function searchAldiBrowser(
  page:    import('playwright').Page,
  query:   string,
): Promise<ParsedProduct[]> {
  const url = `${BASE_URL}?q=${encodeURIComponent(query)}&postal_code=${ZIPCODE}`;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  // Wait for search results to populate — Instacart replaces the storefront
  // items with actual search results after the initial JS hydration
  try {
    await page.waitForLoadState('networkidle', { timeout: 12_000 });
  } catch { /* continue anyway */ }

  const html = await page.content();
  return parseProductsFromHtml(html);
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  // Ensure match_quality column exists (idempotent)
  await pool.query(`
    ALTER TABLE competitor_prices
    ADD COLUMN IF NOT EXISTS match_quality text;
  `);

  const allProducts = await db
    .select({
      id:    products.id,
      name:  products.name,
      brand: products.brand,
      size:  products.size,
    })
    .from(products)
    .orderBy(asc(products.id));

  console.log(`\n[aldi] Fetching prices for ${allProducts.length} products from Aldi/Instacart`);
  console.log(`[aldi] ZIP: ${ZIPCODE} — attaching to Brave via CDP ${CDP_URL}\n`);

  // Connect to Brave
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  try {
    browser = await chromium.connectOverCDP(CDP_URL, { timeout: 6_000 });
    console.log('[cdp] Attached to existing Brave session\n');
  } catch {
    console.error('[cdp] Could not attach to Brave. Start it with:');
    console.error('  --remote-debugging-port=9222 --remote-allow-origins=*');
    process.exit(1);
  }

  const ctx  = browser.contexts()[0] ?? await browser.newContext();
  const page = await ctx.newPage();

  console.log('─'.repeat(80));

  type ReportRow = {
    id:          number;
    salName:     string;
    aldiName:    string;
    price:       string;
    url:         string;
    query:       string;
    attempt:     string;
    status:      'FOUND' | 'NOT_FOUND';
  };

  const report: ReportRow[] = [];
  let found = 0, notFound = 0;

  for (const product of allProducts) {
    const queries = buildQueries(product.name, product.brand, product.size);
    let matched: ParsedProduct | null = null;
    let usedQuery = '';
    let usedAttempt = 'A';

    for (let a = 0; a < queries.length; a++) {
      if (a > 0) await sleep(RETRY_MS);
      try {
        const items = await searchAldiBrowser(page, queries[a]);
        const hit = findBestMatch(items, product.name, product.brand);
        if (hit) {
          matched     = hit;
          usedQuery   = queries[a];
          usedAttempt = String.fromCharCode(65 + a); // A, B, C
          break;
        }
      } catch (err) {
        console.error(`  [browser error] ${product.name}: ${(err as Error).message}`);
      }
    }

    if (matched) {
      // Upsert into competitor_prices
      const existing = await db
        .select({ id: competitorPrices.id })
        .from(competitorPrices)
        .where(and(
          eq(competitorPrices.productId, product.id),
          eq(competitorPrices.store, STORE),
        ))
        .limit(1);

      const priceNum = matched.price.replace('$', '');

      if (existing.length > 0) {
        await db.update(competitorPrices)
          .set({
            price:       priceNum,
            matchedName: matched.name,
            url:         matched.url,
            source:      SOURCE,
            zipcode:     ZIPCODE,
            checkedAt:   new Date(),
          })
          .where(eq(competitorPrices.id, existing[0].id));
      } else {
        await db.insert(competitorPrices).values({
          productId:   product.id,
          store:       STORE,
          zipcode:     ZIPCODE,
          matchedName: matched.name,
          price:       priceNum,
          url:         matched.url,
          source:      SOURCE,
        });
      }

      found++;
      const label = usedAttempt !== 'A' ? ` [via ${usedAttempt}]` : '';
      console.log(
        `  ✓ ${String(product.id).padEnd(4)} ${product.name.slice(0, 38).padEnd(38)}` +
        `  ${matched.price.padStart(6)}  ${matched.name.slice(0, 40)}${label}`,
      );
      report.push({
        id: product.id, salName: product.name,
        aldiName: matched.name, price: matched.price,
        url: matched.url, query: usedQuery, attempt: usedAttempt, status: 'FOUND',
      });
    } else {
      notFound++;
      console.log(
        `  ✗ ${String(product.id).padEnd(4)} ${product.name.slice(0, 38).padEnd(38)}` +
        `  (not found)`,
      );
      report.push({
        id: product.id, salName: product.name,
        aldiName: '', price: '', url: '', query: queries[0], attempt: '', status: 'NOT_FOUND',
      });
    }

    // Polite delay between products
    await sleep(randDelay());
  }

  await page.close();
  await browser.close();

  console.log('─'.repeat(80));
  console.log(`\n[aldi] Done: ${found} found, ${notFound} not found out of ${allProducts.length} products\n`);

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    fetchedAt:   new Date().toISOString(),
    zip:         ZIPCODE,
    store:       STORE,
    total:       allProducts.length,
    found,
    notFound,
    rows:        report,
  }, null, 2), 'utf8');
  console.log(`[saved] ${OUT_FILE}`);
}

main().catch(async err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err);
  await pool.end();
  process.exit(1);
}).finally(() => pool.end());
