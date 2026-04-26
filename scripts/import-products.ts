import { config } from 'dotenv';
import { resolve } from 'path';
import * as XLSX from 'xlsx';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { products } from '../src/db/schema';
import type { NewProduct } from '../src/db/schema';

// Must run before the Pool is created — static imports above are hoisted,
// but none of them instantiate a connection, so env vars are available here.
config({ path: resolve(process.cwd(), '.env.local') });

// ── Column detection ─────────────────────────────────────────────────────────
//
// Save-A-Lot Excel quirks handled here:
//   • Column A has no header → xlsx assigns key "__EMPTY"; it's the product name.
//   • Column "Name" is actually a UPC/barcode, not a product name.
//   • Column "Class" is the category.

const COLUMN_MAP: Record<string, keyof NewProduct> = {
  // name
  'product name': 'name',
  'product':      'name',
  'item name':    'name',
  'item':         'name',
  'description':  'name',
  // brand
  'brand':        'brand',
  'brand name':   'brand',
  'manufacturer': 'brand',
  // size
  'size':         'size',
  'unit size':    'size',
  'pack size':    'size',
  'weight':       'size',
  'volume':       'size',
  // category — "Class" is the Save-A-Lot column name
  'category':     'category',
  'class':        'category',
  'sub class':    'category',
  'department':   'category',
  'section':      'category',
  'aisle':        'category',
  // upc
  'upc':          'upc',
  'upc code':     'upc',
  'barcode':      'upc',
  'ean':          'upc',
  'gtin':         'upc',
  // activeCost — Save-A-Lot acquisition cost
  'active cost':  'activeCost',
  'cost':         'activeCost',
  'unit cost':    'activeCost',
  'avg cost':     'activeCost',
  'average cost': 'activeCost',
};

function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function toStr(val: unknown): string | null {
  if (val === null || val === undefined || val === '') return null;
  const s = String(val).trim();
  return s === '' ? null : s;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — check .env.local');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const shouldTruncate = args.includes('--truncate');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const db = drizzle(pool, { schema: { products } });

  try {
    if (shouldTruncate) {
      await db.execute(sql`TRUNCATE products RESTART IDENTITY`);
      console.log('Truncated products table.\n');
    }

    const filePath = resolve(process.cwd(), 'data/save-a-lot.xlsx');
    console.log(`Reading: ${filePath}`);

    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    console.log(`Sheet:   "${sheetName}"\n`);

    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: '',
    });

    if (rawRows.length === 0) {
      console.log('No rows found in sheet.');
      return;
    }

    const headers = Object.keys(rawRows[0]);
    const headerToField = new Map<string, keyof NewProduct>();

    // ── Special case: xlsx assigns "__EMPTY" to unlabeled header cells.
    // In the Save-A-Lot export, column A has no header but contains the full
    // product name — so we map it to `name` before the generic loop runs.
    if (headers.includes('__EMPTY')) {
      headerToField.set('__EMPTY', 'name');
      console.log('  Mapped: (unlabeled column A) → name');
    }

    // ── Generic column detection via COLUMN_MAP
    for (const header of headers) {
      if (header === '__EMPTY') continue; // already handled above

      const key = normalizeHeader(header);
      const field = COLUMN_MAP[key];

      // Only map a field once (first matching header wins)
      if (field && !Array.from(headerToField.values()).includes(field)) {
        headerToField.set(header, field);
        console.log(`  Mapped: "${header}" → ${field}`);
      }
    }

    if (!Array.from(headerToField.values()).includes('name')) {
      console.error('\nCould not detect a "name" column (required).');
      console.error('Headers found:', headers.join(', '));
      process.exit(1);
    }

    // ── Transform rows
    const rows: NewProduct[] = [];

    for (const raw of rawRows) {
      const row: Record<string, string | null> = {};

      for (const [header, field] of headerToField) {
        row[field] = toStr(raw[header]);
      }

      if (!row.name) continue; // skip blank / separator rows

      rows.push(row as unknown as NewProduct);
    }

    const skipped = rawRows.length - rows.length;
    console.log(
      `\nRows: ${rawRows.length} total — ${skipped} skipped — ${rows.length} to insert`,
    );

    if (rows.length === 0) {
      console.log('Nothing to insert.');
      return;
    }

    // Insert in chunks of 500 to stay under pg's parameter limit
    const batches = chunk(rows, 500);
    let inserted = 0;

    for (const batch of batches) {
      await db.insert(products).values(batch);
      inserted += batch.length;
      process.stdout.write(`\r  Inserted ${inserted} / ${rows.length}...`);
    }

    console.log(`\n\nDone. ${inserted} rows inserted into "products".`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('\nImport failed:', msg);
  process.exit(1);
});
