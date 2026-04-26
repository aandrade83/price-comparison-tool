/**
 * Match SAL products to Aldi catalog and upsert competitor_prices.
 *
 * Uses the shared match-engine (v2) for scoring.
 * Confidence stored: EXACT | HIGH | SUBSTITUTE | LOW
 *
 * RUN: npx tsx scripts/aldi-match-upsert.ts
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

import { drizzle }   from 'drizzle-orm/node-postgres';
import { asc }       from 'drizzle-orm';
import { Pool }      from 'pg';
import * as fs       from 'fs';
import * as path     from 'path';
import { products, competitorPrices } from '../src/db/schema';
import { scoreProducts, type Confidence } from './match-engine';

// ── Config ─────────────────────────────────────────────────────────────────────

const STORE        = 'Aldi';
const SOURCE       = 'aldi_graphql';
const ZIPCODE      = '19138';
const CATALOG_FILE = path.resolve(process.cwd(), 'debug', 'aldi-catalog.json');

// ── DB ─────────────────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const db   = drizzle(pool, { schema: { products, competitorPrices } });

// ── Catalog type ───────────────────────────────────────────────────────────────

interface AldiProduct {
  id: string; name: string; brand: string | null;
  size: string | null; price: string | null;
}

// ── Find best match ────────────────────────────────────────────────────────────

interface ScoredMatch {
  product:    AldiProduct;
  confidence: Confidence;
  points:     number;
  notes:      string[];
}

function findBestMatch(
  sal:     { name: string; brand: string | null; size: string | null },
  catalog: AldiProduct[],
): ScoredMatch | null {
  let best: ScoredMatch | null = null;

  for (const item of catalog) {
    if (!item.price) continue;
    const result = scoreProducts(sal, item);
    if (result.confidence === 'REJECT') continue;
    if (!best || result.points > best.points) {
      best = { product: item, confidence: result.confidence, points: result.points, notes: result.notes };
    }
  }
  return best;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  if (!fs.existsSync(CATALOG_FILE)) { console.error(`Catalog not found: ${CATALOG_FILE}`); process.exit(1); }

  await pool.query(`ALTER TABLE competitor_prices ADD COLUMN IF NOT EXISTS match_quality text;`);
  const del = await pool.query(`DELETE FROM competitor_prices WHERE store = $1`, [STORE]);
  console.log(`[aldi-match] Cleared ${del.rowCount} previous Aldi rows`);

  const catalog: AldiProduct[] = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')).products;
  console.log(`[aldi-match] Catalog: ${catalog.length} Aldi products`);

  const salProducts = await db
    .select({ id: products.id, name: products.name, brand: products.brand, size: products.size })
    .from(products).orderBy(asc(products.id));

  console.log(`[aldi-match] SAL products: ${salProducts.length}\n${'─'.repeat(115)}`);

  type Row = { id: number; salName: string; aldiName: string; price: string; confidence: string; points: number; notes: string; status: string };
  const report: Row[] = [];
  const counts: Record<string, number> = { EXACT: 0, HIGH: 0, SUBSTITUTE: 0, LOW: 0, NOT_FOUND: 0 };

  for (const prod of salProducts) {
    const best = findBestMatch(prod, catalog);

    if (best) {
      const { product: aldi, confidence, points, notes } = best;

      await db.insert(competitorPrices).values({
        productId:    prod.id,
        store:        STORE,
        zipcode:      ZIPCODE,
        matchedName:  aldi.name,
        price:        aldi.price!,
        url:          `https://www.aldi.us/p/${aldi.id}`,
        source:       SOURCE,
        matchQuality: confidence,
      });

      counts[confidence]++;
      const icon = confidence === 'EXACT' ? '★★' : confidence === 'HIGH' ? '✓✓' : confidence === 'SUBSTITUTE' ? '≈ ' : '~ ';
      console.log(
        `  ${icon} ${String(prod.id).padEnd(4)} ${prod.name.slice(0,35).padEnd(35)} →` +
        ` $${aldi.price!.padStart(5)}  ${aldi.name.slice(0,38).padEnd(38)}` +
        ` [${confidence}](${points}) ${notes.slice(0,4).join(' ')}`,
      );
      report.push({ id: prod.id, salName: prod.name, aldiName: aldi.name, price: aldi.price!,
        confidence, points, notes: notes.join(' '), status: 'FOUND' });
    } else {
      counts['NOT_FOUND']++;
      console.log(`  ✗  ${String(prod.id).padEnd(4)} ${prod.name.slice(0,35).padEnd(35)}  (no match)`);
      report.push({ id: prod.id, salName: prod.name, aldiName: '', price: '',
        confidence: 'N/A', points: 0, notes: '', status: 'NOT_FOUND' });
    }
  }

  console.log(`${'─'.repeat(115)}`);
  console.log(`\n[aldi-match] Results:`);
  console.log(`  EXACT:       ${counts.EXACT}`);
  console.log(`  HIGH:        ${counts.HIGH}`);
  console.log(`  SUBSTITUTE:  ${counts.SUBSTITUTE}`);
  console.log(`  LOW:         ${counts.LOW}`);
  console.log(`  NOT FOUND:   ${counts.NOT_FOUND}`);
  console.log(`  Total:       ${salProducts.length}\n`);

  const outFile = path.resolve(process.cwd(), 'debug', 'aldi-match-report.json');
  fs.writeFileSync(outFile, JSON.stringify({
    matchedAt: new Date().toISOString(), counts, rows: report,
  }, null, 2), 'utf8');
  console.log(`[saved] ${outFile}`);
}

main().catch(async err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err);
  await pool.end(); process.exit(1);
}).finally(() => pool.end());
