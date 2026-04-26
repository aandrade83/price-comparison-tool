import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') });

import { drizzle } from 'drizzle-orm/node-postgres';
import { asc } from 'drizzle-orm';
import { Pool } from 'pg';
import { products, competitorPrices } from '../src/db/schema';
import { searchProduct } from '../providers/walmart';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const db = drizzle(pool, { schema: { products, competitorPrices } });

const ZIPCODE      = '19138';
const DELAY_MS     = 2_000;
const STORE        = 'Walmart';

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const rows = await db
    .select()
    .from(products)
    .orderBy(asc(products.id))
    .limit(50);

  const total = rows.length;
  console.log(`Found ${total} products. Starting Walmart search...\n`);

  let inserted  = 0;
  let skipped   = 0;
  let failed    = 0;

  for (const [i, product] of rows.entries()) {
    const idx = i + 1;
    process.stdout.write(`[${idx}/${total}] ${product.name.slice(0, 55).padEnd(55)} `);

    try {
      const results = await searchProduct(product.name, ZIPCODE);

      if (results.length === 0) {
        console.log('→ no results');
        skipped++;
      } else {
        const best = results[0];

        await db.insert(competitorPrices).values({
          productId:   product.id,
          store:       STORE,
          zipcode:     ZIPCODE,
          matchedName: best.name,
          price:       String(best.price),
          size:        best.size,
          url:         best.url,
          source:      best.source,
        });

        console.log(`→ $${best.price.toFixed(2).padStart(5)} [${best.source}] ${best.name.slice(0, 35)}`);
        inserted++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`→ ERROR: ${msg.slice(0, 60)}`);
      failed++;
    }

    if (idx < total) await sleep(DELAY_MS);
  }

  console.log('\n' + '─'.repeat(70));
  console.log(`Done.  inserted: ${inserted}  skipped: ${skipped}  errors: ${failed}`);

  await pool.end();
}

main().catch(async (err: unknown) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  await pool.end();
  process.exit(1);
});
