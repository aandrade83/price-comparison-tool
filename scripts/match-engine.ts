/**
 * Shared product match-scoring engine v2.
 *
 * Weights:
 *   Brand exact       +40    (both brands confirmed same)
 *   Brand mismatch    -20    (both confirmed different non-private)
 *   Category exact    +30    (same product type)
 *   Category compat   +5     (related but not same, e.g. choc_wafer ~ choc_bar)
 *   Variant match     +15    (pepperoni, chicken, strawberry, etc.)
 *   Variant conflict  -20    (SAL has a variant word that comp doesn't)
 *   Size ≤10%         +15
 *   Size 11-50%       +5
 *   Size >50%         -5
 *   Keyword overlap   +10    (capped at 2 matches → max +20)
 *
 * Confidence thresholds:
 *   EXACT      ≥ 95   same brand + category + variant + size
 *   HIGH       ≥ 80   same brand + category (slight variant/size tolerance)
 *   SUBSTITUTE ≥ 50   different/private brand, same category + comparable type
 *   LOW        ≥ 25   weak signal — hidden by default
 *   REJECT      < 25  or category conflict
 *
 * Special rule:
 *   If comp brand is private-label and SAL brand is a national brand,
 *   confidence is capped at SUBSTITUTE (never HIGH or EXACT).
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type Confidence = 'EXACT' | 'HIGH' | 'SUBSTITUTE' | 'LOW' | 'REJECT';

export interface MatchScore {
  confidence: Confidence;
  points:     number;
  notes:      string[];
}

export interface ProductRef {
  name:  string;
  brand: string | null;
  size:  string | null;
}

// ── Weights & thresholds ──────────────────────────────────────────────────────

const W = {
  BRAND_EXACT:       40,
  BRAND_MISMATCH:   -20,
  CAT_EXACT:         30,
  CAT_COMPAT:         5,
  VARIANT:           15,
  VARIANT_CONFLICT: -20,
  SIZE_CLOSE:        15,  // ≤10%
  SIZE_OK:            5,  // 11-50%
  SIZE_FAR:          -5,  // >50%
  KW:                10,  // per keyword, capped at 2 → max +20
} as const;

const THR = { EXACT: 95, HIGH: 80, SUBSTITUTE: 50, LOW: 25 } as const;

// ── Stop words ─────────────────────────────────────────────────────────────────

const STOP = new Set([
  'the','a','an','of','in','and','with','for','by','from','its',
  'oz','lb','lbs','g','mg','ml','ct','pk','fl','floz','ounce','ounces',
  'can','cans','bag','bags','box','boxes','jar','jug','tub','pack','package',
  'bottle','bottles','cup','cups','pouch','stick','sticks',
  'original','classic','style','new','old','world','pure','real',
  'fresh','natural','best','great','value','premium',
  'mini','large','small','big','extra','super','ultra',
  'baked','roasted','smoked','grilled','dried','canned','frozen',
  'complete','adult','regular','light','lite','low','free',
  'quick','easy','homestyle','traditional',
  'item','items','dip','food','foods','bar','bars',
  'meat','flesh','liquid','hand',
  'white','dark','red','blue','green','black','yellow',
  'spicy','savory','tangy','hot','mild',
  'brand','brands','company','corp','inc',
  'farm','farms','town','country','golden','happy','friendly',
  'nature','simply','specially','selected',
  // Noise words that leak from product names into keyword matching
  'art','burger','flavor','flavored','flavors','variety',
]);

// ── Text helpers ───────────────────────────────────────────────────────────────

export function norm(s: string): string {
  return s
    .replace(/[®™©!]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\bFL\.?\s*OZ\b/gi, 'oz')
    .replace(/\bBBQ\b/gi, 'barbecue')   // normalize abbreviation
    .replace(/\bMac\s*&\s*Cheese\b/gi, 'macaroni and cheese')
    .replace(/,/g, ' ').replace(/&/g, 'and')
    .replace(/\s+/g, ' ').toLowerCase().trim();
}

function esc(w: string) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function wordIn(word: string, text: string): boolean {
  const pat = word.length <= 4 ? `\\b${esc(word)}\\b` : `\\b${esc(word)}s?\\b`;
  return new RegExp(pat, 'i').test(text);
}

export function coreWords(name: string, brand: string | null): string[] {
  let text = norm(name);
  if (brand) {
    norm(brand).split(/\s+/).filter(t => t.length >= 3).forEach(t => {
      text = text.replace(new RegExp(`\\b${esc(t)}\\b`, 'g'), ' ');
    });
  }
  text = text.replace(/\d+\.?\d*\s*(?:oz|fl\s*oz|lb|lbs?|g|ml|ct|pk)\b/gi, ' ');
  const seen = new Set<string>();
  return text.split(/\s+/)
    .filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w))
    .filter(w => { if (seen.has(w)) return false; seen.add(w); return true; });
}

// ── Size parsing ───────────────────────────────────────────────────────────────

function parseOz(name: string, size: string | null): number | null {
  const text = ((size ?? '') + ' ' + name).toLowerCase();
  let m: RegExpMatchArray | null;
  m = text.match(/(\d+\.?\d*)\s*fl\.?\s*oz/);  if (m) return parseFloat(m[1]);
  m = text.match(/(\d+\.?\d*)\s*oz/);           if (m) return parseFloat(m[1]);
  m = text.match(/(\d+\.?\d*)\s*lbs?/);         if (m) return parseFloat(m[1]) * 16;
  m = text.match(/(\d+\.?\d*)\s*g\b/);          if (m) return parseFloat(m[1]) * 0.03527;
  m = text.match(/(\d+\.?\d*)\s*ml\b/);         if (m) return parseFloat(m[1]) * 0.03381;
  return null;
}

// ── Category detection ─────────────────────────────────────────────────────────

const CAT_RULES: { cat: string; re: RegExp }[] = [
  // Beverages
  { cat: 'coconut_water',   re: /\bcoconut\s+water\b/i },
  { cat: 'coconut_juice',   re: /\bcoconut\s+juice\b/i },
  { cat: 'juice_drink',     re: /\bjuice\s+(?:drink|cocktail)\b/i },
  { cat: 'probiotic_soda',  re: /\bprobiotic\s+soda\b/i },
  { cat: 'energy_drink',    re: /\benergy\s+drink\b/i },
  // Chocolate (before candy — "milk chocolate candy bar" → choc_bar not candy)
  { cat: 'choc_wafer',      re: /\b(?:crisp\s+wafers?\s+in\b|chocolate.{0,20}wafers?|wafers?.{0,20}chocolate|kit\s*kat)\b/i },
  { cat: 'choc_bar',        re: /\b(?:milk|dark|white)\s+chocolate(?:\s+(?:extra\s+large\s+)?(?:candy\s+)?bar)?\b/i },
  { cat: 'hazelnut_spread', re: /\bhazelnut\s+spread\b/i },
  // Candy (after chocolate)
  { cat: 'candy_chew',      re: /\bhi.?chew\b/i },
  { cat: 'hard_candy',      re: /\bhard\s+candy\b/i },
  { cat: 'candy',           re: /\bcandy\b/i },
  // Pasta (before sauces)
  { cat: 'mac_cheese',      re: /\bmac(?:aroni)?\s*(?:and|n|&)\s*cheese\b/i },
  { cat: 'shells_cheese',   re: /\bshells?\s+(?:pasta\s+)?(?:and|&|n)\s*cheese\b/i },
  { cat: 'velveeta',        re: /\bvelveeta\b/i },
  // Sauces / condiments
  { cat: 'barbecue_sauce',  re: /\bbarbecue\s+sauce\b/i },   // after norm() converts BBQ→barbecue
  { cat: 'ketchup',         re: /\bketchup\b/i },
  { cat: 'pasta_sauce',     re: /\bpasta\s+sauce\b/i },
  { cat: 'tomato_sauce',    re: /\btomato\s+sauce\b/i },
  { cat: 'cheese_dip',      re: /\bcheez\s+whiz\b/i },
  { cat: 'mayo',            re: /\bmayonnaise\b/i },
  // Pizza
  { cat: 'pizza',           re: /\bpizzas?\b/i },
  // Soups
  { cat: 'noodle_soup',     re: /\b(?:noodle\s+(?:cup|soup|bowl)|instant\s+(?:noodle|soup|lunch)|ramen)\b/i },
  { cat: 'soup',            re: /\bsoups?\b/i },
  // Snacks
  { cat: 'potato_chips',    re: /\bpotato\s+(?:chips?|crisps?)\b/i },
  { cat: 'chips',           re: /\bchips?\b/i },
  // Spreads / dairy
  { cat: 'butter_spread',   re: /\bvegetable\s+oil\s+spread\b|i\s+can.t\s+believe\b|tastes?\s+like\s+butter\b|margarine\b/i },
  { cat: 'amer_cheese',     re: /\bamerican\s+cheese\s+slices?\b/i },
  // Grains / breakfast
  { cat: 'cereal',          re: /\bcereal\b|\bgranola\b|\bfrosted\s+flakes\b|\bbran\s+flakes\b|\bcorn\s+flakes\b/i },
  { cat: 'syrup',           re: /\b(?:pancake\s+)?syrup\b/i },
  // Staples
  { cat: 'mashed_potato',   re: /\bmashed\s+potat/i },
  { cat: 'pigeon_peas',     re: /\bpigeon\s+peas?\b/i },
  { cat: 'canned_meat',     re: /\bcanned\s+meat\b/i },
  { cat: 'salami',          re: /\bsalami\b/i },
  // Pet
  { cat: 'dog_food',        re: /\bdog\s+(?:food|chow|treats?|kibble)\b|\bpet\s+food\b/i },
  // Non-food
  { cat: 'dish_soap',       re: /\bdish\s+(?:soap|liquid|detergent)\b/i },
  { cat: 'tire_product',    re: /\btire\b/i },
];

// Compatible category pairs (same product family, interchangeable)
const COMPAT = new Set([
  'pasta_sauce|tomato_sauce', 'tomato_sauce|pasta_sauce',
  'mac_cheese|shells_cheese', 'shells_cheese|mac_cheese',
  'mac_cheese|velveeta',      'velveeta|mac_cheese',
  'shells_cheese|velveeta',   'velveeta|shells_cheese',
  'coconut_water|coconut_juice', 'coconut_juice|coconut_water',
  'potato_chips|chips',       'chips|potato_chips',
  'choc_wafer|choc_bar',      'choc_bar|choc_wafer',
  'noodle_soup|soup',         'soup|noodle_soup',
  'candy_chew|candy',         'candy|candy_chew',
  'hard_candy|candy',         'candy|hard_candy',
  'candy_chew|hard_candy',    'hard_candy|candy_chew',
]);

export function detectCat(name: string): string | null {
  // Run category detection on norm()-processed name so BBQ→barbecue etc. is applied
  const n = norm(name);
  for (const { cat, re } of CAT_RULES) if (re.test(n)) return cat;
  return null;
}

function catsOk(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;   // unknown category = don't reject
  if (a === b) return true;
  return COMPAT.has(`${a}|${b}`);
}

// ── Private-label brand set ────────────────────────────────────────────────────

const PRIVATE_LABELS = new Set([
  // Aldi private labels
  "mama cozzi's pizza kitchen","mama cozzi's","mama cozzis",
  "chef's cupboard","chefs cupboard","nature's nectar","natures nectar",
  "millville","park street deli","clancy's","clancys",
  "choceur","deutsche küche","deutsche kuche",
  "happy harvest","happy farms","priano","summit",
  "appleton farms","brookdale","friendly farms",
  "simply nature","specially selected",
  "baker's corner","bakers corner","l'oven fresh","loven fresh",
  "benton's","bentons","countryside creamery","goldhen",
  "kirkwood","bremer","reggano","casa mamita",
  "fit & active","fit and active","earth grown",
  "never any!","never any","burman's","burmans","stonemill",
  "savoritz","southern grove","sweet additions","sweet harvest",
  "tuscan garden","season's choice","seasons choice",
  "fremont fish market","northern catch","sea queen",
  "dakota's pride","dakotas pride","parkview","livegfree",
  "fusia","pueblo lindo","puraqua","breakfast best",
  "cheese club","emporium selection","elevation",
  "little salad bar","little journey","lunch buddies","lunch mate",
  "belavi","lacura","flavorables","simms",
  "oh snap!","oh snap","rainier fruit company",
  "philly gourmet","bob evans farms","aldi",
  // Walmart private labels
  "great value","equate","george","mainstays","better goods",
  "sam's choice","marketside","parent's choice","parents choice",
  "ol' roy","ol roy",
]);

export function isPrivateLabel(brand: string | null): boolean {
  if (!brand) return false;
  return PRIVATE_LABELS.has(brand.toLowerCase().trim());
}

// ── Variant words (define the specific product) ───────────────────────────────

const VARIANT_WORDS = [
  // Proteins (mutually exclusive within a category)
  'chicken','beef','pork','seafood','shrimp','turkey','tuna','fish','ham',
  'lamb','lobster','crab','clam','salmon',
  // Pizza / sandwich toppings
  'pepperoni','sausage','supreme','hawaiian','veggie',
  // Sauce variants
  'marinara','alfredo','arrabbiata',
  // Flavor identifiers
  'strawberry','watermelon','cherry','grape','lemon','lime','orange','mango',
  'vanilla','cinnamon','maple','buttermilk',
  // Dairy type
  'whole','skim','lowfat',
];

function variantIn(word: string, text: string): boolean {
  return new RegExp(`\\b${esc(word)}\\b`, 'i').test(text);
}

export function variantScore(nameA: string, nameB: string): { bonus: number; conflict: number } {
  let bonus = 0, conflict = 0;
  const normA = norm(nameA), normB = norm(nameB);
  for (const w of VARIANT_WORDS) {
    const inA = variantIn(w, normA);
    const inB = variantIn(w, normB);
    if (inA && inB)  bonus++;
    if (inA && !inB) conflict++;    // SAL specifies a variant comp doesn't have
  }
  return { bonus, conflict };
}

// ── Main scoring function ─────────────────────────────────────────────────────

export function scoreProducts(sal: ProductRef, comp: ProductRef): MatchScore {
  const notes: string[] = [];
  let pts = 0;

  // ── 1. Category gate ──────────────────────────────────────────────────
  const catA = detectCat(sal.name);
  const catB = detectCat(comp.name);

  if (catA && catB) {
    if (!catsOk(catA, catB)) {
      return { confidence: 'REJECT', points: -99,
               notes: [`cat_reject:${catA}≠${catB}`] };
    }
    if (catA === catB) { pts += W.CAT_EXACT;  notes.push(`cat:${catA}(+${W.CAT_EXACT})`); }
    else               { pts += W.CAT_COMPAT; notes.push(`cat:compat(${catA}~${catB})(+${W.CAT_COMPAT})`); }
  } else if (catA && !catB) {
    pts -= 5; notes.push(`cat:sal_only(${catA})(-5)`);
  } else if (!catA && catB) {
    pts -= 2; notes.push(`cat:comp_only(${catB})(-2)`);
  }

  // ── 2. Keyword overlap (hard requirement: ≥ 1) ───────────────────────
  const salWords = coreWords(sal.name, sal.brand);
  const compText = norm(comp.name + ' ' + (comp.brand ?? ''));
  let kwCount = 0;
  for (const w of salWords) if (wordIn(w, compText)) kwCount++;

  if (kwCount === 0) {
    return { confidence: 'REJECT', points: -99, notes: ['no_keyword_overlap'] };
  }
  const kwPts = Math.min(kwCount, 2) * W.KW;
  pts += kwPts;
  notes.push(`kw:${kwCount}(+${kwPts})`);

  // ── 3. Brand matching ─────────────────────────────────────────────────
  const bA = sal.brand?.toLowerCase().trim() ?? null;
  const bB = comp.brand?.toLowerCase().trim() ?? null;
  let compIsPrivate = false;

  if (bA && bB) {
    const same = bA === bB || bA.includes(bB) || bB.includes(bA);
    if (same) {
      pts += W.BRAND_EXACT;
      notes.push(`brand:exact(+${W.BRAND_EXACT})`);
    } else if (isPrivateLabel(bB)) {
      compIsPrivate = true;
      notes.push('brand:private_label(+0)');
    } else {
      pts += W.BRAND_MISMATCH;
      notes.push(`brand:mismatch(${W.BRAND_MISMATCH})`);
    }
  } else if (bA && !bB) {
    // Competitor brand unknown — check if SAL brand appears in comp name
    const compNorm = norm(comp.name);
    const bAn = norm(bA);
    if (bAn.split(/\s+/).some(t => t.length >= 3 && compNorm.includes(t))) {
      pts += W.BRAND_EXACT;
      notes.push(`brand:found_in_name(+${W.BRAND_EXACT})`);
    }
    // Otherwise neutral (no bonus, no penalty)
  }

  // ── 4. Variant score ──────────────────────────────────────────────────
  const { bonus, conflict } = variantScore(sal.name, comp.name);
  if (bonus > 0)    { const p = bonus   * W.VARIANT;           pts += p; notes.push(`variant:match(+${p})`); }
  if (conflict > 0) { const p = conflict * W.VARIANT_CONFLICT; pts += p; notes.push(`variant:conflict(${p})`); }

  // ── 5. Size matching ──────────────────────────────────────────────────
  const ozA = parseOz(sal.name, sal.size);
  const ozB = parseOz(comp.name, comp.size);
  if (ozA && ozB) {
    const ratio = Math.max(ozA, ozB) / Math.min(ozA, ozB);
    if (ratio <= 1.10)      { pts += W.SIZE_CLOSE; notes.push(`size:close(${ozA.toFixed(1)}≈${ozB.toFixed(1)}oz)(+${W.SIZE_CLOSE})`); }
    else if (ratio <= 1.50) { pts += W.SIZE_OK;    notes.push(`size:ok(+${W.SIZE_OK})`); }
    else                    { pts += W.SIZE_FAR;   notes.push(`size:far(${ozA.toFixed(1)} vs ${ozB.toFixed(1)}oz)(${W.SIZE_FAR})`); }
  }

  // ── 6. Reject if net negative ─────────────────────────────────────────
  if (pts < 0) return { confidence: 'REJECT', points: pts, notes };

  // ── 7. Map to confidence level ────────────────────────────────────────
  let confidence: Confidence;
  if      (pts >= THR.EXACT)      confidence = 'EXACT';
  else if (pts >= THR.HIGH)       confidence = 'HIGH';
  else if (pts >= THR.SUBSTITUTE) confidence = 'SUBSTITUTE';
  else if (pts >= THR.LOW)        confidence = 'LOW';
  else                            confidence = 'REJECT';

  // Business rule: private-label competitor cannot rank EXACT or HIGH
  // (exact/high require same brand — private labels are always substitutes)
  if (compIsPrivate && bA && (confidence === 'EXACT' || confidence === 'HIGH')) {
    confidence = 'SUBSTITUTE';
    notes.push('capped:SUBSTITUTE(private_label)');
  }

  return { confidence, points: pts, notes };
}
