/**
 * Aldi / Instacart popup detection + search viability test.
 *
 * Tests whether the Instacart ALDI storefront can be used for price
 * scraping when a login/signup popup intercepts the session.
 *
 * Steps:
 *   1. Open storefront — detect any blocking overlay
 *   2. Attempt popup dismissal via multiple strategies
 *   3. Set ZIP context (19138) and search for "milk"
 *   4. Extract product data
 *   5. Verify a second search works (popup does not re-block)
 *   6. Print verdict + save debug/aldi-popup-test.json
 *
 * RUN:
 *   npx tsx scripts/test-aldi-popup-search.ts
 *
 * REQUIRES:
 *   Brave running with --remote-debugging-port=9222 --remote-allow-origins=*
 */

import { chromium, type Page, type BrowserContext } from 'playwright';
import * as fs   from 'fs';
import * as path from 'path';

// ── Config ─────────────────────────────────────────────────────────────────────

const CDP_URL   = 'http://localhost:9222';
const ZIPCODE   = '19138';
const BASE_URL  = `https://www.instacart.com/store/aldi/storefront?postal_code=${ZIPCODE}`;

const DEBUG_DIR = path.resolve(process.cwd(), 'debug');
const OUT_FILE  = path.join(DEBUG_DIR, 'aldi-popup-test.json');

// ── Types ──────────────────────────────────────────────────────────────────────

interface ParsedProduct {
  name:  string;
  price: string;
  size:  string;
  url:   string;
}

interface PopupAttempt {
  strategy: string;
  worked:   boolean;
  detail:   string;
}

interface SearchResult {
  query:       string;
  found:       boolean;
  products:    ParsedProduct[];
  itemCount:   number;
  error?:      string;
}

// ── HTML extraction ─────────────────────────────────────────────────────────────

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

    const lookback = html.slice(Math.max(0, m.index - 2000), m.index);

    const priceMatch = lookback.match(/Current price: (\$[\d.]+)(?![\s\S]*Current price:)/);
    if (!priceMatch) continue;

    // Size: look for unit tag near the heading
    const lookahead = html.slice(m.index, m.index + 400);
    const sizeMatch = lookahead.match(/\b(\d+\.?\d*\s*(?:oz|lb|lbs?|g|ml|ct|pk|gal|fl oz|each|per lb))\b/i);
    const size      = sizeMatch ? sizeMatch[1] : '';

    const urlMatch = lookback.match(/href="(\/store\/aldi\/products\/[^"]+)"(?![\s\S]*href="\/store\/aldi\/products\/)/);
    const url       = urlMatch
      ? `https://www.instacart.com${urlMatch[1]}`
      : BASE_URL;

    results.push({ name, price: priceMatch[1], size, url });
  }

  return results;
}

// ── Popup detection ─────────────────────────────────────────────────────────────

async function hasBlockingOverlay(page: Page): Promise<{ blocked: boolean; details: string }> {
  return page.evaluate((): { blocked: boolean; details: string } => {
    const details: string[] = [];

    // Check for visible modal/dialog elements
    const dialogs = document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [data-testid*="modal"], [class*="Modal"], [class*="modal"], [class*="overlay"], [class*="Overlay"]'
    );
    for (const el of Array.from(dialogs)) {
      const style = window.getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null) {
        details.push(`dialog/modal visible: ${el.tagName} class="${el.className.slice(0, 80)}"`);
      }
    }

    // Check for dark semi-transparent overlay (z-index > 100, covers viewport)
    const allEls = document.querySelectorAll<HTMLElement>('*');
    for (const el of Array.from(allEls).slice(0, 2000)) {
      const style = window.getComputedStyle(el);
      const z = parseInt(style.zIndex || '0');
      if (z > 100 && parseFloat(style.opacity || '1') < 0.95) {
        const rect = el.getBoundingClientRect();
        if (rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.3) {
          details.push(`dark overlay z=${z}: ${el.tagName}.${String(el.className).slice(0, 60)}`);
          break;
        }
      }
    }

    // Check for "Sign in" / "Log in" / email input in visible context
    const inputs = document.querySelectorAll<HTMLInputElement>('input[type="email"], input[placeholder*="email"]');
    for (const inp of Array.from(inputs)) {
      if (inp.offsetParent !== null) {
        details.push('email input visible — signup/login form active');
        break;
      }
    }

    return { blocked: details.length > 0, details: details.join(' | ') };
  });
}

// ── Popup dismissal strategies ─────────────────────────────────────────────────

async function tryDismissPopup(page: Page): Promise<PopupAttempt[]> {
  const attempts: PopupAttempt[] = [];

  // Strategy 1: Escape key
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    const { blocked } = await hasBlockingOverlay(page);
    attempts.push({ strategy: 'Escape key', worked: !blocked, detail: blocked ? 'still blocked' : 'cleared' });
    if (!blocked) return attempts;
  } catch (e) {
    attempts.push({ strategy: 'Escape key', worked: false, detail: String(e) });
  }

  // Strategy 2: Click "Continue as guest" / "Not now" / "No thanks" / "Skip" buttons
  const guestTexts = [
    'Continue as guest',
    'Continue without signing in',
    'Not now',
    'No thanks',
    'Skip',
    'Close',
    'Maybe later',
    'Continue browsing',
  ];

  for (const text of guestTexts) {
    try {
      const btn = page.getByRole('button', { name: new RegExp(text, 'i') }).first();
      const visible = await btn.isVisible({ timeout: 1_500 }).catch(() => false);
      if (visible) {
        await btn.click({ timeout: 3_000 });
        await page.waitForTimeout(800);
        const { blocked } = await hasBlockingOverlay(page);
        attempts.push({ strategy: `Click "${text}"`, worked: !blocked, detail: blocked ? 'still blocked' : 'cleared' });
        if (!blocked) return attempts;
      }
    } catch { /* try next */ }
  }

  // Strategy 3: Click close button (aria-label contains close/dismiss)
  const closeSelectors = [
    'button[aria-label*="close" i]',
    'button[aria-label*="dismiss" i]',
    'button[aria-label*="Cancel" i]',
    '[data-testid*="close"]',
    '[data-testid*="dismiss"]',
    '[class*="close-btn"]',
    '[class*="CloseButton"]',
    '[class*="closeButton"]',
    'svg[aria-label*="close" i]',
  ];

  for (const sel of closeSelectors) {
    try {
      const el = page.locator(sel).first();
      const visible = await el.isVisible({ timeout: 1_200 }).catch(() => false);
      if (visible) {
        await el.click({ timeout: 3_000 });
        await page.waitForTimeout(800);
        const { blocked } = await hasBlockingOverlay(page);
        attempts.push({ strategy: `Click ${sel}`, worked: !blocked, detail: blocked ? 'still blocked' : 'cleared' });
        if (!blocked) return attempts;
      }
    } catch { /* try next */ }
  }

  // Strategy 4: Click outside the modal (top-left corner, typically outside)
  try {
    await page.mouse.click(10, 10);
    await page.waitForTimeout(800);
    const { blocked } = await hasBlockingOverlay(page);
    attempts.push({ strategy: 'Click outside (10,10)', worked: !blocked, detail: blocked ? 'still blocked' : 'cleared' });
    if (!blocked) return attempts;
  } catch (e) {
    attempts.push({ strategy: 'Click outside', worked: false, detail: String(e) });
  }

  // Strategy 5: Remove overlay from DOM via JS
  try {
    const removed = await page.evaluate((): number => {
      let count = 0;
      const candidates = document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [role="alertdialog"], [class*="modal" i], [class*="overlay" i], [class*="popup" i]'
      );
      for (const el of Array.from(candidates)) {
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null) {
          el.remove();
          count++;
        }
      }
      // Also remove any body overflow:hidden that modals add
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
      return count;
    });
    await page.waitForTimeout(500);
    const { blocked } = await hasBlockingOverlay(page);
    attempts.push({
      strategy: `Remove modal from DOM (removed ${removed} elements)`,
      worked: !blocked,
      detail: blocked ? 'still blocked' : 'cleared',
    });
  } catch (e) {
    attempts.push({ strategy: 'Remove modal from DOM', worked: false, detail: String(e) });
  }

  return attempts;
}

// ── Search execution ────────────────────────────────────────────────────────────

async function searchProduct(
  page:  Page,
  query: string,
): Promise<SearchResult> {
  const url = `https://www.instacart.com/store/aldi/storefront?q=${encodeURIComponent(query)}&postal_code=${ZIPCODE}`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Check for popup on this page and dismiss if present
    const { blocked } = await hasBlockingOverlay(page);
    if (blocked) {
      await tryDismissPopup(page);
    }

    // Wait for network to settle (search API call to complete)
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    const html     = await page.content();
    const products = parseProductsFromHtml(html);

    const keyword = query.toLowerCase();
    const matching = products.filter(p => p.name.toLowerCase().includes(keyword));

    return {
      query,
      found:     matching.length > 0,
      products:  matching.slice(0, 5),
      itemCount: products.length,
    };
  } catch (err) {
    return {
      query,
      found:     false,
      products:  [],
      itemCount: 0,
      error:     (err as Error).message,
    };
  }
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  const log = (...args: unknown[]) => console.log(...args);

  log('\n════════════════════════════════════════════════════════════');
  log('  ALDI / INSTACART POPUP + SEARCH TEST');
  log(`  ZIP: ${ZIPCODE}  ·  Demo: 6301 Chew Ave, Philadelphia PA`);
  log('════════════════════════════════════════════════════════════\n');

  // ── Connect to Brave ────────────────────────────────────────────────────────
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  try {
    browser = await chromium.connectOverCDP(CDP_URL, { timeout: 6_000 });
    log('[cdp] Attached to existing Brave session');
  } catch {
    log('[cdp] Brave not detected — launching headless Chromium');
    browser = await (chromium.launch({ headless: false, slowMo: 50 }) as never);
  }

  const ctx  = browser.contexts()[0] ?? await (browser as never as import('playwright').Browser).newContext();
  const page = await ctx.newPage();

  const result = {
    testedAt:       new Date().toISOString(),
    zipcode:        ZIPCODE,
    baseUrl:        BASE_URL,
    initialPopup:   { detected: false, details: '' },
    dismissal:      [] as PopupAttempt[],
    popupCleared:   false,
    searchResults:  [] as SearchResult[],
    verdict:        '',
    verdictCode:    '',
    recommendation: '',
  };

  // ── Step 1: Load storefront + detect popup ──────────────────────────────────
  log('[step 1] Loading Aldi / Instacart storefront...');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2_000); // let JS hydrate

  const initialState = await hasBlockingOverlay(page);
  result.initialPopup = { detected: initialState.blocked, details: initialState.details };

  if (initialState.blocked) {
    log(`  ✗ Popup/overlay detected: ${initialState.details}`);
  } else {
    log('  ✓ No blocking overlay detected on initial load');
  }

  // ── Step 2: Dismiss popup ───────────────────────────────────────────────────
  if (initialState.blocked) {
    log('\n[step 2] Attempting popup dismissal...');
    const attempts = await tryDismissPopup(page);
    result.dismissal = attempts;
    for (const a of attempts) {
      const icon = a.worked ? '  ✓' : '  ✗';
      log(`${icon} ${a.strategy} → ${a.detail}`);
    }
    const lastWorked = attempts.some(a => a.worked);
    result.popupCleared = lastWorked;
    if (!lastWorked) {
      log('\n  All dismissal strategies failed. Popup still blocking.');
    }
  } else {
    result.popupCleared = true;
    log('[step 2] No popup to dismiss.');
  }

  // ── Step 3: Search for "milk" ───────────────────────────────────────────────
  log('\n[step 3] Searching for "milk"...');
  const milkResult = await searchProduct(page, 'milk');
  result.searchResults.push(milkResult);

  if (milkResult.error) {
    log(`  ✗ Search error: ${milkResult.error}`);
  } else if (milkResult.found) {
    log(`  ✓ Found ${milkResult.products.length} milk product(s) (${milkResult.itemCount} total items in page)`);
    for (const p of milkResult.products) {
      log(`    ${p.price.padStart(6)}  ${p.name}${p.size ? '  [' + p.size + ']' : ''}`);
      log(`           ${p.url}`);
    }
  } else {
    log(`  ✗ "milk" not found in ${milkResult.itemCount} products on page`);
  }

  // ── Step 4: Verify repeated search works ───────────────────────────────────
  log('\n[step 4] Verifying second search works ("bread")...');
  await page.waitForTimeout(1_500);
  const breadResult = await searchProduct(page, 'bread');
  result.searchResults.push(breadResult);

  if (breadResult.found) {
    log(`  ✓ "bread" found — repeated search works (${breadResult.itemCount} items)`);
    for (const p of breadResult.products) {
      log(`    ${p.price.padStart(6)}  ${p.name}`);
    }
  } else {
    log(`  ✗ "bread" not found — repeated search may be blocked`);
  }

  // ── Step 5: Verdict ─────────────────────────────────────────────────────────
  const milkOk  = milkResult.found;
  const breadOk = breadResult.found;
  const popupOk = result.popupCleared;

  let verdictCode: 'A' | 'B' | 'C' | 'D';
  let verdict: string;
  let recommendation: string;

  if (milkOk && breadOk && popupOk) {
    verdictCode    = 'A';
    verdict        = 'A) Popup can be bypassed reliably — search works';
    recommendation =
      'Proceed with aldi-batch-prices.ts using Playwright CDP. ' +
      'Run popup dismissal once at start of each session before the batch loop. ' +
      'No login required.';
  } else if (!milkOk && !breadOk && !popupOk) {
    verdictCode    = 'B';
    verdict        = 'B) Popup blocks automation — cannot search without login';
    recommendation =
      'Option 1: Manually log in to Instacart in Brave, then re-run — ' +
      'the session cookie will persist for CDP scraping. ' +
      'Option 2: Use a different data source (Aldi weekly ad, Flipp API).';
  } else if (milkOk && (!popupOk || !breadOk)) {
    verdictCode    = 'C';
    verdict        = 'C) Need persistent logged session — partial search works';
    recommendation =
      'Log in to Instacart manually in Brave once. ' +
      'The session cookie in the browser profile persists across CDP sessions. ' +
      'After login, all searches work without popup.';
  } else {
    verdictCode    = 'D';
    verdict        = 'D) Need alternate source — Instacart automation unreliable';
    recommendation =
      'Consider: Flipp API for Aldi weekly ads, direct Aldi.us product catalog, ' +
      'or manual price entry for the ~30 core Aldi products that map to SAL items.';
  }

  result.verdict        = verdict;
  result.verdictCode    = verdictCode;
  result.recommendation = recommendation;

  log('\n\n════════════════════════════════════════════════════════════');
  log('  FINAL VERDICT');
  log('════════════════════════════════════════════════════════════\n');
  log(`  ${verdict}`);
  log(`\n  Popup detected:  ${result.initialPopup.detected ? 'YES — ' + result.initialPopup.details.slice(0, 80) : 'No'}`);
  log(`  Popup cleared:   ${result.popupCleared ? 'Yes' : 'No'}`);
  log(`  Milk found:      ${milkOk ? '✓' : '✗'}`);
  log(`  Bread found:     ${breadOk ? '✓' : '✗'}`);
  log(`\n  Recommendation:`);
  log(`  → ${recommendation}`);
  log('');

  await page.close();
  await browser.close();

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), 'utf8');
  log(`[saved] ${OUT_FILE}\n`);
}

main().catch(err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
