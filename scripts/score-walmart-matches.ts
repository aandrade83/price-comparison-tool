/**
 * Re-score existing Walmart competitor_prices using the shared match-engine v2.
 *
 * Confidence stored: EXACT | HIGH | SUBSTITUTE | LOW
 *
 * RUN: npx tsx scripts/score-walmart-matches.ts
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

import { drizzle }              from 'drizzle-orm/node-postgres';
import { eq, and, isNotNull }   from 'drizzle-orm';
import { Pool }                 from 'pg';
import * as fs                  from 'fs';
import * as path                from 'path';
import { products, competitorPrices } from '../src/db/schema';
import { scoreProducts }        from './match-engine';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const db   = drizzle(pool, { schema: { products, competitorPrices } });

const DEBUG_DIR = path.resolve(process.cwd(), 'debug');
const OUT_FILE  = path.join(DEBUG_DIR, 'walmart-match-quality.json');

async function main() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

  await pool.query(`ALTER TABLE competitor_prices ADD COLUMN IF NOT EXISTS match_quality text;`);
  console.log('[db] match_quality column ready\n');

  const rows = await db
    .select({
      cpId:        competitorPrices.id,
      productId:   competitorPrices.productId,
      price:       competitorPrices.price,
      matchedName: competitorPrices.matchedName,
      salName:     products.name,
      salBrand:    products.brand,
      salSize:     products.size,
    })
    .from(competitorPrices)
    .innerJoin(products, eq(competitorPrices.productId, products.id))
    .where(and(eq(competitorPrices.store, 'Walmart'), isNotNull(competitorPrices.matchedName)))
    .orderBy(competitorPrices.productId);

  console.log(`[db] ${rows.length} Walmart matches to score\n${'─'.repeat(115)}`);

  type ReportRow = {
    product_id: number | null; sal_name: string; walmart_name: string;
    price: string; confidence: string; points: number; notes: string;
  };

  const report: ReportRow[] = [];
  const counts: Record<string, number> = { EXACT: 0, HIGH: 0, SUBSTITUTE: 0, LOW: 0 };

  for (const row of rows) {
    const compName = row.matchedName ?? '';
    const result = scoreProducts(
      { name: row.salName,  brand: row.salBrand ?? null, size: row.salSize ?? null },
      { name: compName,     brand: null,                 size: null },
    );

    // Walmart matched names include the brand in the product name, so brand is encoded there.
    // scoreProducts will pick it up via keyword and category overlap.
    const confidence = result.confidence === 'REJECT' ? 'LOW' : result.confidence;

    await db.update(competitorPrices)
      .set({ matchQuality: confidence })
      .where(eq(competitorPrices.id, row.cpId));

    counts[confidence] = (counts[confidence] ?? 0) + 1;

    const icon = confidence === 'EXACT' ? '★★' : confidence === 'HIGH' ? '✓✓' : confidence === 'SUBSTITUTE' ? '≈ ' : '~ ';
    console.log(
      `  ${icon} ${String(row.productId ?? '').padEnd(4)}` +
      ` ${row.salName.slice(0,35).padEnd(35)} →` +
      ` $${(row.price ?? '').padStart(5)}` +
      `  ${compName.slice(0,40).padEnd(40)}` +
      ` [${confidence}](${result.points})`,
    );

    report.push({
      product_id: row.productId, sal_name: row.salName, walmart_name: compName,
      price: row.price ?? '—', confidence, points: result.points, notes: result.notes.join(' '),
    });
  }

  console.log(`${'─'.repeat(115)}`);
  console.log(`\n[walmart-score] Results:`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(12)} ${v}`);
  console.log(`  ${'Total'.padEnd(12)} ${rows.length}\n`);

  fs.writeFileSync(OUT_FILE, JSON.stringify({ scoredAt: new Date().toISOString(), counts, rows: report }, null, 2), 'utf8');
  console.log(`[saved] ${OUT_FILE}`);
}

main().catch(async err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err);
  await pool.end(); process.exit(1);
}).finally(() => pool.end());
