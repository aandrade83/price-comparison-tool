/**
 * Find nearest Aldi stores to ZIP 19138 (Philadelphia, PA).
 *
 * Sources:
 *   1. Nominatim (OpenStreetMap) — free ZIP → lat/lon geocoding
 *   2. Overpass API (OpenStreetMap) — real Aldi store nodes/ways with
 *      address, phone, hours, coordinates
 *
 * Both APIs are public, rate-limit-friendly, and require no API key.
 * Aldi's own stores.aldi.us is behind Cloudflare and returns 403.
 *
 * RUN:
 *   npx tsx scripts/find-aldi-store.ts
 *   npx tsx scripts/find-aldi-store.ts 19103   ← optional different ZIP
 *
 * OUTPUT:
 *   Console summary + debug/aldi-stores-19138.json
 */

import * as fs   from 'fs';
import * as path from 'path';

const ZIP       = process.argv[2] ?? '19138';
const RADIUS_M  = 30_000;           // search radius in metres (≈18.6 miles)
const TOP_N     = 5;

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OVERPASS  = 'https://overpass-api.de/api/interpreter';
const UA        = 'price-odds-store-finder/1.0 (github.com/price-odds)';

const DEBUG_DIR = path.resolve(process.cwd(), 'debug');
const OUT_FILE  = path.join(DEBUG_DIR, `aldi-stores-${ZIP}.json`);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Haversine distance between two lat/lon points, result in miles */
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R    = 3_958.8;
  const toR  = (d: number) => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/** Build best-effort stores.aldi.us page URL from address components */
function storeUrl(state: string, city: string, address: string): string {
  const slug = (s: string) => s.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  if (!state || !city || !address) return 'https://stores.aldi.us/';
  return `https://stores.aldi.us/${slug(state)}/${slug(city)}/${slug(address)}`;
}

// ── OSM types ─────────────────────────────────────────────────────────────────

interface OsmElement {
  type:    'node' | 'way' | 'relation';
  id:      number;
  lat?:    number;
  lon?:    number;
  center?: { lat: number; lon: number };
  tags:    Record<string, string>;
}

interface OverpassResult { elements: OsmElement[] }

interface StoreResult {
  storeId:        string;
  storeName:      string;
  address:        string;
  city:           string;
  state:          string;
  zip:            string;
  phone:          string;
  lat:            number;
  lng:            number;
  distance_miles: number;
  store_url:      string;
  hours?:         string;
  osm_type:       string;
  osm_id:         number;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  // ── Step 1: Geocode ZIP ────────────────────────────────────────────────────
  console.log(`\n[geo] Geocoding ZIP ${ZIP} via Nominatim…`);

  const geoRes = await fetch(
    `${NOMINATIM}?postalcode=${ZIP}&country=us&format=json&limit=1&addressdetails=1`,
    { headers: { 'User-Agent': UA } },
  );

  if (!geoRes.ok) throw new Error(`Nominatim HTTP ${geoRes.status}`);

  const geoData = await geoRes.json() as Array<{
    lat: string; lon: string; display_name: string;
  }>;

  if (!geoData.length) throw new Error(`No geocode result for ZIP ${ZIP}`);

  const originLat = parseFloat(geoData[0].lat);
  const originLon = parseFloat(geoData[0].lon);
  console.log(`[geo] ${ZIP} → ${originLat.toFixed(5)}, ${originLon.toFixed(5)}`);
  console.log(`[geo] ${geoData[0].display_name}`);

  // ── Step 2: Overpass — find ALDI stores within radius ─────────────────────
  console.log(`\n[overpass] Querying ALDI stores within ${RADIUS_M / 1000} km…`);

  // Query both node and way elements tagged name=ALDI within the radius.
  // "out center tags" returns the centroid of ways alongside their tags.
  const overpassQuery = `
[out:json][timeout:30];
(
  node["name"="ALDI"](around:${RADIUS_M},${originLat},${originLon});
  way["name"="ALDI"](around:${RADIUS_M},${originLat},${originLon});
);
out center tags;
`.trim();

  const ovRes = await fetch(OVERPASS, {
    method:  'POST',
    body:    `data=${encodeURIComponent(overpassQuery)}`,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':   UA,
    },
  });

  if (!ovRes.ok) throw new Error(`Overpass HTTP ${ovRes.status}`);

  const ovData = await ovRes.json() as OverpassResult;
  console.log(`[overpass] ${ovData.elements.length} elements returned`);

  if (ovData.elements.length === 0) {
    console.error('[overpass] No ALDI stores found — try increasing RADIUS_M');
    process.exit(1);
  }

  // ── Step 3: Parse, calculate distance, sort ────────────────────────────────
  const stores: StoreResult[] = [];

  for (const el of ovData.elements) {
    const t       = el.tags ?? {};
    const storeLat = el.lat ?? el.center?.lat;
    const storeLon = el.lon ?? el.center?.lon;
    if (storeLat == null || storeLon == null) continue;

    const houseNum = t['addr:housenumber'] ?? '';
    const street   = t['addr:street']      ?? '';
    const city     = t['addr:city']        ?? '';
    const state    = t['addr:state']       ?? '';
    const zip      = t['addr:postcode']    ?? '';
    const phone    = t['phone'] ?? t['contact:phone'] ?? '';
    const hours    = t['opening_hours']    ?? '';
    const name     = t['name']             ?? 'ALDI';
    const ref      = t['ref']              ?? '';

    const address  = [houseNum, street].filter(Boolean).join(' ');
    if (!address || !city) continue;    // skip elements with no usable address

    const dist = haversine(originLat, originLon, storeLat, storeLon);

    stores.push({
      storeId:        ref || String(el.id),
      storeName:      name,
      address,
      city,
      state,
      zip,
      phone,
      lat:            storeLat,
      lng:            storeLon,
      distance_miles: Math.round(dist * 100) / 100,
      store_url:      storeUrl(state, city, address),
      hours:          hours || undefined,
      osm_type:       el.type,
      osm_id:         el.id,
    });
  }

  stores.sort((a, b) => a.distance_miles - b.distance_miles);
  const top = stores.slice(0, TOP_N);

  // ── Step 4: Console summary ────────────────────────────────────────────────
  const line = '─'.repeat(64);
  console.log('\n' + line);
  console.log(`TOP ${top.length} ALDI STORES NEAR ZIP ${ZIP}`);
  console.log(line);
  for (let i = 0; i < top.length; i++) {
    const s = top[i];
    console.log(`\n#${i + 1}  ALDI — ${s.distance_miles} miles`);
    console.log(`    ${s.address}, ${s.city}, ${s.state} ${s.zip}`);
    if (s.phone) console.log(`    ${s.phone}`);
    if (s.hours) console.log(`    Hours: ${s.hours}`);
    console.log(`    ${s.store_url}`);
    console.log(`    OSM: ${s.osm_type}/${s.osm_id}`);
  }
  console.log('\n' + line);
  console.log(`${stores.length} total stores found within ${RADIUS_M / 1000} km`);

  // ── Step 5: Save JSON ──────────────────────────────────────────────────────
  const output = {
    query_zip:    ZIP,
    query_lat:    originLat,
    query_lon:    originLon,
    fetched_at:   new Date().toISOString(),
    source:       'OpenStreetMap Overpass API + Nominatim geocoder',
    radius_km:    RADIUS_M / 1000,
    total_found:  stores.length,
    top_5:        top,
    all_stores:   stores,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n[saved] ${OUT_FILE}`);
}

main().catch(err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
