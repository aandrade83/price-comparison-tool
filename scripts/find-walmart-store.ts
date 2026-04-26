/**
 * Find nearest Walmart stores to Zone 1 (Save A Lot, 6301 Chew Ave, Philadelphia 19138).
 *
 * Origin: Nominatim geocode of Save A Lot store address — 40.0512956°N, 75.1734731°W.
 *
 * Data sources (no API key required):
 *   Overpass API — finds all Walmart-branded locations within radius
 *   Haversine    — ranks by real driving-proxy distance from zone origin
 */

// ── Zone origin — Save A Lot, 6301 Chew Ave, Philadelphia 19138 ──────────────

const ZONE = {
  label: 'Save A Lot, 6301 Chew Ave, Philadelphia PA 19138',
  lat:    40.0512956,
  lon:   -75.1734731,
};

const RADIUS_M    = 40_000; // 40 km search radius
const MAX_RESULTS = 5;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StoreResult {
  store_id:  string;
  name:      string;
  address:   string;
  miles:     number;
  type:      string;   // 'Supercenter' | 'Walmart' | 'Neighborhood Market'
  phone:     string;
  url:       string;
  default:   boolean;  // true for the nearest store only
}

interface OverpassElement {
  type:    'node' | 'way' | 'relation';
  id:      number;
  lat?:    number;
  lon?:    number;
  center?: { lat: number; lon: number };
  tags:    Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

// ── Geo ───────────────────────────────────────────────────────────────────────

function haversineMiles(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R    = 3_958.8;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) *
    Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Store type from OSM tags ──────────────────────────────────────────────────

function resolveType(tags: Record<string, string>): string {
  const name = (tags.name ?? '').toLowerCase();
  if (name.includes('supercenter'))        return 'Supercenter';
  if (name.includes('neighborhood market') ||
      name.includes('neighbourhood market')) return 'Neighborhood Market';
  // Fall back to OSM shop category
  if (tags.shop === 'supermarket')         return 'Supercenter';
  if (tags.shop === 'convenience')         return 'Neighborhood Market';
  return 'Walmart';
}

// ── Overpass fetch ────────────────────────────────────────────────────────────

async function fetchStores(
  lat: number,
  lon: number,
  radiusM: number,
): Promise<OverpassElement[]> {
  const query = `
[out:json][timeout:25];
(
  node["brand"="Walmart"](around:${radiusM},${lat},${lon});
  way["brand"="Walmart"](around:${radiusM},${lat},${lon});
  relation["brand"="Walmart"](around:${radiusM},${lat},${lon});
);
out body center;
`.trim();

  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method:  'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':   'PriceOdds/1.0 (price comparison research)',
    },
    body:   'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(30_000),
  });

  const data = (await res.json()) as OverpassResponse;
  return data.elements ?? [];
}

// ── Parse, dedupe, rank ───────────────────────────────────────────────────────

function parseStores(
  elements: OverpassElement[],
  originLat: number,
  originLon: number,
): StoreResult[] {
  const seen = new Set<string>();
  const out:  Omit<StoreResult, 'default'>[] = [];

  for (const el of elements) {
    const tags = el.tags ?? {};

    // Skip pharmacy sub-departments (not a store entrance)
    if (tags.amenity === 'pharmacy' && !tags.shop) continue;

    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;

    const storeId = tags['ref:walmart'] ?? tags['ref'] ?? String(el.id);
    if (seen.has(storeId)) continue;
    seen.add(storeId);

    // Build address
    const addrParts: string[] = [];
    if (tags['addr:housenumber'] && tags['addr:street']) {
      let street = `${tags['addr:housenumber']} ${tags['addr:street']}`;
      if (tags['addr:unit']) street += ` #${tags['addr:unit']}`;
      addrParts.push(street);
    }
    if (tags['addr:city'])     addrParts.push(tags['addr:city']);
    if (tags['addr:state'])    addrParts.push(tags['addr:state']);
    if (tags['addr:postcode']) addrParts.push(tags['addr:postcode']);

    out.push({
      store_id: storeId,
      name:     tags.name ?? 'Walmart',
      address:  addrParts.join(', ') || 'Address unknown',
      miles:    Math.round(haversineMiles(originLat, originLon, lat, lon) * 10) / 10,
      type:     resolveType(tags),
      phone:    tags.phone ?? tags['contact:phone'] ?? '—',
      url:      tags.website ?? `https://www.walmart.com/store/${storeId}`,
    });
  }

  const ranked = out
    .sort((a, b) => a.miles - b.miles)
    .slice(0, MAX_RESULTS);

  return ranked.map((s, i) => ({ ...s, default: i === 0 }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Zone origin  :', ZONE.label);
  console.log('Coordinates  :', `${ZONE.lat}°N, ${Math.abs(ZONE.lon)}°W`);
  console.log('Search radius:', `${RADIUS_M / 1000} km`);
  console.log('─'.repeat(62));

  process.stdout.write('\nQuerying Overpass API… ');
  const elements = await fetchStores(ZONE.lat, ZONE.lon, RADIUS_M);
  console.log(`${elements.length} raw elements\n`);

  const stores = parseStores(elements, ZONE.lat, ZONE.lon);

  if (stores.length === 0) {
    console.log('No Walmart stores found within radius.');
    return;
  }

  console.log(`Top ${stores.length} nearest Walmart stores:\n`);

  // Table header
  const cols = { rank: 4, id: 7, type: 20, miles: 7, name: 24 };
  console.log(
    'Rank'.padEnd(cols.rank),
    'ID'.padEnd(cols.id),
    'Type'.padEnd(cols.type),
    'Miles'.padStart(cols.miles),
    'Name',
  );
  console.log('─'.repeat(62));

  for (const s of stores) {
    const rank = s.default ? ' ★ 1' : `   ${stores.indexOf(s) + 1}`;
    console.log(
      rank.padEnd(cols.rank),
      s.store_id.padEnd(cols.id),
      s.type.padEnd(cols.type),
      String(s.miles).padStart(cols.miles - 3) + ' mi',
      s.name,
    );
  }

  console.log('─'.repeat(62));
  console.log(`\n★ Default comparison store: ${stores[0].name} #${stores[0].store_id}`);

  console.log('\nFull details:\n');
  for (const [i, s] of stores.entries()) {
    const marker = s.default ? ' ★ DEFAULT' : '';
    console.log(`[${i + 1}]${marker}`);
    console.log(`    store_id : ${s.store_id}`);
    console.log(`    name     : ${s.name}`);
    console.log(`    type     : ${s.type}`);
    console.log(`    address  : ${s.address}`);
    console.log(`    miles    : ${s.miles}`);
    console.log(`    phone    : ${s.phone}`);
    console.log(`    url      : ${s.url}`);
    console.log();
  }
}

main().catch((err: unknown) => {
  console.error('Failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
