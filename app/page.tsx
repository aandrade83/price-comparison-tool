import { eq, and, asc } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/src/db';
import { products as productsTable, competitorPrices } from '@/src/db/schema';

function fmt(n: number): string {
  return `$${n.toFixed(2)}`;
}

function QualityBadge({ quality }: { quality: string | null }) {
  if (!quality) return null;
  const cfg: Record<string, { label: string; cls: string }> = {
    EXACT:      { label: 'EXACT MATCH',     cls: 'bg-green-400/10 text-green-400 ring-green-400/20' },
    HIGH:       { label: 'HIGH CONFIDENCE', cls: 'bg-blue-400/10  text-blue-400  ring-blue-400/20'  },
    SUBSTITUTE: { label: 'SUBSTITUTE',      cls: 'bg-amber-400/10 text-amber-400 ring-amber-400/20' },
    LOW:        { label: 'LOW',             cls: 'bg-red-500/10   text-red-400   ring-red-500/20'   },
  };
  const c = cfg[quality];
  if (!c) return null;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ring-1 ring-inset ${c.cls}`}>
      {c.label}
    </span>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ showWalmartLow?: string; showAldiLow?: string }>
}) {
  const { showWalmartLow, showAldiLow } = await searchParams;
  const showLowMatches  = showWalmartLow === '1';  // kept for backward-compat row filter
  const showAldiLowMatches = showAldiLow === '1';

  const walmartPrices = alias(competitorPrices, 'walmart_prices');
  const aldiPrices    = alias(competitorPrices, 'aldi_prices');

  const allRows = await db
    .select({
      id:              productsTable.id,
      name:            productsTable.name,
      brand:           productsTable.brand,
      size:            productsTable.size,
      activeCost:      productsTable.activeCost,
      walmartPrice:    walmartPrices.price,
      walmartUrl:      walmartPrices.url,
      walmartQuality:  walmartPrices.matchQuality,
      aldiPrice:       aldiPrices.price,
      aldiUrl:         aldiPrices.url,
      aldiQuality:     aldiPrices.matchQuality,
      aldiMatchedName: aldiPrices.matchedName,
    })
    .from(productsTable)
    .leftJoin(
      walmartPrices,
      and(
        eq(walmartPrices.productId, productsTable.id),
        eq(walmartPrices.store, 'Walmart'),
      ),
    )
    .leftJoin(
      aldiPrices,
      and(
        eq(aldiPrices.productId, productsTable.id),
        eq(aldiPrices.store, 'Aldi'),
      ),
    )
    .orderBy(asc(productsTable.id))
    .limit(50);

  // Summary counts
  const exactCount    = allRows.filter(r => r.walmartQuality === 'EXACT').length;
  const highCount     = allRows.filter(r => r.walmartQuality === 'HIGH').length;
  const subCount      = allRows.filter(r => r.walmartQuality === 'SUBSTITUTE').length;
  const walmartLow    = allRows.filter(r => r.walmartQuality === 'LOW').length;
  const aldiLow       = allRows.filter(r => r.aldiQuality === 'LOW').length;
  const lowCount      = walmartLow + aldiLow;
  const aldiCount     = allRows.filter(r => r.aldiPrice !== null && r.aldiQuality !== 'LOW').length;

  // URL helpers for independent store toggles
  const walmartToggle = (() => {
    const p = new URLSearchParams();
    if (!showLowMatches)     p.set('showWalmartLow', '1');
    if (showAldiLowMatches)  p.set('showAldiLow', '1');
    const q = p.toString(); return q ? `/?${q}` : '/';
  })();
  const aldiToggle = (() => {
    const p = new URLSearchParams();
    if (showLowMatches)       p.set('showWalmartLow', '1');
    if (!showAldiLowMatches)  p.set('showAldiLow', '1');
    const q = p.toString(); return q ? `/?${q}` : '/';
  })();

  // Filter for display
  const rows = showLowMatches
    ? allRows
    : allRows.filter(r => r.walmartQuality !== 'LOW');

  const summaryCards = [
    { label: 'Products Processed', value: allRows.length, valCls: 'text-white'     },
    { label: 'Exact Matches',      value: exactCount,     valCls: 'text-green-400' },
    { label: 'High Confidence',    value: highCount,      valCls: 'text-blue-400'  },
    { label: 'Substitutes',        value: subCount,       valCls: 'text-amber-400' },
    { label: 'Aldi Matches',       value: aldiCount,      valCls: 'text-[#e8334a]' },
  ];

  return (
    <div className="min-h-screen bg-[#070b13] text-white">

      {/* ── Header ── */}
      <header className="border-b border-[#192235] bg-[#050810]">
        <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-black tracking-[0.2em] uppercase">
            PRICE<span className="text-green-400">ODDS</span>
          </h1>
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-[11px] font-bold uppercase tracking-widest text-green-400">Live</span>
          </div>
        </div>
      </header>

      {/* ── Zone subheader ── */}
      <div className="border-b border-[#192235] bg-[#090e18]">
        <div className="mx-auto max-w-7xl px-6 py-2.5 flex items-center gap-3 text-sm">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-600">Zone</span>
          <span className="font-bold text-white">Zone 1</span>
          <span className="text-slate-700">|</span>
          <span className="text-slate-400">6301 Chew Ave</span>
          <span className="text-slate-700">·</span>
          <span className="font-mono text-slate-400">19138</span>
        </div>
      </div>

      <main className="mx-auto max-w-7xl px-6 py-8 space-y-6">

        {/* ── Summary Cards ── */}
        <div className="grid grid-cols-5 gap-3">
          {summaryCards.map(card => (
            <div
              key={card.label}
              className="rounded-xl border border-[#192235] bg-[#080d17] px-5 py-4"
            >
              <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600 leading-tight">
                {card.label}
              </p>
              <p className={`mt-2.5 text-3xl font-black tabular-nums ${card.valCls}`}>
                {card.value}
              </p>
            </div>
          ))}
        </div>

        {/* ── Table area ── */}
        {rows.length === 0 ? (
          <div className="rounded-2xl border border-[#192235] bg-[#0a0f1a] px-8 py-16 text-center">
            <p className="text-slate-500 text-sm uppercase tracking-widest">No products found.</p>
          </div>
        ) : (
          <>
            {/* Controls bar — one row per store */}
            <div className="space-y-2">

              {/* Walmart row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[11px] font-mono text-slate-600 uppercase tracking-widest">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#4a9eff]" />
                  Walmart #5229 · Wyncote PA · 2.1 mi
                </div>
                <a
                  href={walmartToggle}
                  className={`flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-widest transition-colors ${
                    showLowMatches
                      ? 'border-red-500/30 bg-red-500/5 text-red-400 hover:bg-red-500/10'
                      : 'border-[#192235] bg-[#0a0f1a] text-slate-500 hover:border-[#243050] hover:text-slate-400'
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${showLowMatches ? 'bg-red-400' : 'bg-slate-700'}`} />
                  {showLowMatches
                    ? 'Hide low confidence'
                    : `Show low confidence (${walmartLow})`}
                </a>
              </div>

              {/* Aldi row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[11px] font-mono text-slate-600 uppercase tracking-widest">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#e8334a]" />
                  Aldi · 6119 N Broad St · Philadelphia PA · 0.9 mi
                </div>
                <a
                  href={aldiToggle}
                  className={`flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-widest transition-colors ${
                    showAldiLowMatches
                      ? 'border-red-500/30 bg-red-500/5 text-red-400 hover:bg-red-500/10'
                      : 'border-[#192235] bg-[#0a0f1a] text-slate-500 hover:border-[#243050] hover:text-slate-400'
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${showAldiLowMatches ? 'bg-red-400' : 'bg-slate-700'}`} />
                  {showAldiLowMatches
                    ? 'Hide low confidence'
                    : `Show low confidence (${aldiLow})`}
                </a>
              </div>

            </div>

            {/* Table */}
            <div className="overflow-x-auto rounded-2xl border border-[#192235]">
              <table className="w-full text-sm">

                <thead>
                  <tr className="border-b border-[#192235] bg-[#050810]">
                    <th className="px-6 py-4 text-left text-[11px] font-semibold uppercase tracking-widest text-slate-600">Product</th>
                    <th className="px-4 py-4 text-left text-[11px] font-semibold uppercase tracking-widest text-slate-600">Brand</th>
                    <th className="px-4 py-4 text-left text-[11px] font-semibold uppercase tracking-widest text-slate-600">Size</th>
                    <th className="px-4 py-4 text-right text-[11px] font-semibold uppercase tracking-widest text-amber-400">Active Cost</th>
                    <th className="px-6 py-4 text-right text-[11px] font-semibold uppercase tracking-widest text-[#4a9eff]">
                      <div className="flex flex-col items-end gap-0.5">
                        <span>Walmart</span>
                        <span className="text-[10px] font-normal normal-case tracking-normal text-slate-600">
                          Wyncote #5229
                        </span>
                      </div>
                    </th>
                    <th className="px-4 py-4 text-right text-[11px] font-semibold uppercase tracking-widest text-[#4a9eff]/70">% Cost</th>
                    <th className="px-6 py-4 text-right text-[11px] font-semibold uppercase tracking-widest text-[#e8334a]">Aldi</th>
                    <th className="px-4 py-4 text-right text-[11px] font-semibold uppercase tracking-widest text-[#e8334a]/70">% Cost</th>
                    <th className="px-6 py-4 text-center text-[11px] font-semibold uppercase tracking-widest text-green-400">Best Price</th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((row, i) => {
                    const q         = row.walmartQuality;
                    const isLow     = q === 'LOW';
                    const wRaw      = row.walmartPrice !== null ? parseFloat(row.walmartPrice) : null;
                    const walmart   = wRaw !== null && !isLow ? wRaw : null;
                    const aRaw      = row.aldiPrice !== null ? parseFloat(row.aldiPrice) : null;
                    const aldiIsLow = row.aldiQuality === 'LOW';
                    const aldi      = aRaw !== null && (!aldiIsLow || showAldiLowMatches) ? aRaw : null;
                    const cost      = row.activeCost != null ? parseFloat(row.activeCost) : null;
                    const pctW      = cost && walmart !== null ? ((walmart - cost) / cost) * 100 : null;
                    const pctA      = cost && aldi !== null ? ((aldi - cost) / cost) * 100 : null;
                    const best: string | null =
                      walmart !== null && aldi !== null ? (walmart <= aldi ? 'Walmart' : 'Aldi')
                      : walmart !== null ? 'Walmart'
                      : aldi !== null ? 'Aldi'
                      : null;
                    const isLast    = i === rows.length - 1;

                    return (
                      <tr
                        key={row.id}
                        className={[
                          'transition-colors',
                          isLow ? 'opacity-50' : 'hover:bg-[#0d1525]',
                          isLast ? '' : 'border-b border-[#121b2b]',
                        ].join(' ')}
                      >
                        {/* Product */}
                        <td className="px-6 py-4 font-semibold text-white">{row.name}</td>

                        {/* Brand */}
                        <td className="px-4 py-4 text-slate-500">{row.brand ?? '—'}</td>

                        {/* Size */}
                        <td className="px-4 py-4 font-mono text-slate-500">{row.size ?? '—'}</td>

                        {/* Active Cost */}
                        <td className="px-4 py-4 text-right font-mono text-amber-400/80 tabular-nums">
                          {cost !== null ? fmt(cost) : <span className="text-slate-700">—</span>}
                        </td>

                        {/* Walmart price + quality badge */}
                        <td className="px-6 py-4 text-right">
                          {wRaw !== null ? (
                            <div className="flex flex-col items-end gap-1">
                              <span className={`font-mono text-base font-bold tabular-nums ${
                                isLow            ? 'text-red-400/70'
                                : best === 'Walmart' ? 'text-green-400'
                                : 'text-slate-400'
                              }`}>
                                {fmt(wRaw)}
                              </span>
                              <QualityBadge quality={q} />
                            </div>
                          ) : (
                            <span className="font-mono text-slate-700">—</span>
                          )}
                        </td>

                        {/* % Cost Walmart */}
                        <td className="px-4 py-4 text-right font-mono tabular-nums">
                          {pctW !== null ? (
                            <span className={`text-sm font-semibold ${pctW >= 0 ? 'text-[#4a9eff]/70' : 'text-green-400/70'}`}>
                              {pctW >= 0 ? '+' : ''}{pctW.toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-slate-700">—</span>
                          )}
                        </td>

                        {/* Aldi */}
                        <td className="px-6 py-4 text-right">
                          {aldi !== null ? (
                            <div className="flex flex-col items-end gap-1.5">
                              <span className={`font-mono text-base font-bold tabular-nums ${
                                best === 'Aldi' ? 'text-green-400' : 'text-slate-400'
                              }`}>
                                {fmt(aldi)}
                              </span>
                              <QualityBadge quality={row.aldiQuality} />
                              {row.aldiMatchedName && (
                                <span
                                  className="max-w-[10rem] truncate text-right text-[9px] font-medium text-slate-600"
                                  title={row.aldiMatchedName}
                                >
                                  {row.aldiMatchedName}
                                </span>
                              )}
                              <span className="text-[9px] font-semibold uppercase tracking-wider text-[#e8334a]/50">
                                alt. brand
                              </span>
                            </div>
                          ) : (
                            <div className="flex flex-col items-end gap-0.5">
                              <span className="font-mono text-slate-700">—</span>
                              <span className="text-[9px] font-medium uppercase tracking-wider text-slate-800">
                                not carried
                              </span>
                            </div>
                          )}
                        </td>

                        {/* % Cost Aldi */}
                        <td className="px-4 py-4 text-right font-mono tabular-nums">
                          {pctA !== null ? (
                            <span className={`text-sm font-semibold ${pctA >= 0 ? 'text-[#e8334a]/70' : 'text-green-400/70'}`}>
                              {pctA >= 0 ? '+' : ''}{pctA.toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-slate-700">—</span>
                          )}
                        </td>

                        {/* Best Price */}
                        <td className="px-6 py-4 text-center">
                          {best !== null ? (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-green-400/10 px-3 py-1 text-xs font-bold text-green-400 ring-1 ring-inset ring-green-400/20">
                              <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                              {best}
                            </span>
                          ) : (
                            <span className="text-slate-700 text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>

              </table>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4 text-[11px] font-mono text-slate-700 uppercase tracking-widest">
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#4a9eff]" />
                  walmart: {exactCount} exact · {highCount} high · {subCount} sub
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#e8334a]" />
                  aldi: {aldiCount} matched
                </span>
                {lowCount > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                    {walmartLow}w + {aldiLow}a low{showLowMatches ? ' (visible)' : ' (hidden)'}
                  </span>
                )}
              </div>
              <p className="text-[11px] font-mono text-slate-700 uppercase tracking-widest">
                {allRows.length} products · updated 2026-04-25
              </p>
            </div>
          </>
        )}

      </main>
    </div>
  );
}
