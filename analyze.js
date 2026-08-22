#!/usr/bin/env node
/**
 * Turn data/history.csv into signals.
 *
 *   node analyze.js
 *
 * This is deliberately NOT a forecasting model. Sealed TCG prices are thin and
 * event-driven; fitting a curve to them produces confident-looking noise.
 * What this does instead is classify what a position is currently DOING, and
 * flag the setups that historically precede a move.
 *
 * Writes data/signals.json for the frontend and prints a table.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const HISTORY = "data/history.csv";
const OUT = "data/signals.json";

function parseCsv(text) {
  // Strip BOM and normalise CRLF — Excel and Google Sheets both write \r\n,
  // which would otherwise corrupt the header's last column name.
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim().split("\n");
  const cols = lines[0].split(",");
  return lines.slice(1).map((line) => {
    // simple split is unsafe with quoted commas; handle quotes properly
    const vals = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { vals.push(cur); cur = ""; }
      else cur += c;
    }
    vals.push(cur);
    return Object.fromEntries(cols.map((c, i) => [c, vals[i] ?? ""]));
  });
}

const num = (v) => (v === "" || v == null ? null : Number(v));

/** % change from the observation closest to `days` ago. */
function changeOver(series, days) {
  if (series.length < 2) return null;
  const latest = series[series.length - 1];
  const target = new Date(latest.d);
  target.setDate(target.getDate() - days);
  const older = series.filter((p) => new Date(p.d) <= target).pop();
  if (!older || !older.v || !latest.v) return null;
  return ((latest.v - older.v) / older.v) * 100;
}

/** Annualised-ish volatility from daily log returns. */
function volatility(series) {
  if (series.length < 8) return null;
  const rets = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1].v, b = series[i].v;
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 5) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr) * Math.sqrt(365) * 100;
}

function classify({ d7, d30, d90, spread, spreadTrend, vol }) {
  if (d30 == null) return { regime: "insufficient-data", note: "Need ~30 days of snapshots." };

  // Scale the "is this a real move?" threshold to the product's own volatility.
  // A 5% move on a quiet case is signal; the same move on a jumpy box is noise.
  // vol is annualised %, so expected 1-sigma drift over N days is vol*sqrt(N/365).
  const sigma30 = vol != null ? vol * Math.sqrt(30 / 365) : null;
  const sigma7 = vol != null ? vol * Math.sqrt(7 / 365) : null;
  const t30 = Math.max(3, 1.5 * (sigma30 ?? 0));
  const t7 = Math.max(2, 1.5 * (sigma7 ?? 0));

  const rising30 = d30 > t30;
  const falling30 = d30 < -t30;
  const rising7 = d7 != null && d7 > t7;
  const falling7 = d7 != null && d7 < -t7;

  if (rising30 && rising7)
    return { regime: "uptrend", note: "Sustained climb. Let it run; don't add at the top." };
  if (rising30 && falling7)
    return { regime: "uptrend-cooling", note: "30d up but 7d rolling over. Watch for a lower high." };
  if (falling30 && rising7)
    return { regime: "bounce", note: "Downtrend with a short-term pop. Often a dead-cat bounce, not a bottom." };
  if (falling30 && falling7)
    return { regime: "downtrend", note: "Consistent bleed. Reprint or oversupply until proven otherwise." };

  // 30d trend with a neutral 7d reading — still a trend, just consolidating.
  if (rising30)
    return { regime: "uptrend-consolidating", note: "30d up, short term flat. Digesting the move, not reversing yet." };
  if (falling30)
    return { regime: "downtrend-basing", note: "30d down, short term flat. Possible base forming — needs confirmation." };

  if (spread != null && spread > 18 && spreadTrend === "widening")
    return { regime: "supply-thinning", note: "Flat price but widening spread — sellers pulling back. Classic pre-run-up setup." };
  return { regime: "flat", note: "Rangebound. No signal either way." };
}

function main() {
  if (!existsSync(HISTORY)) {
    console.log("No data/history.csv yet. Run collect.js first.");
    return;
  }
  return readFile(HISTORY, "utf8").then(async (text) => {
    const rows = parseCsv(text);
    const byProduct = new Map();
    for (const r of rows) {
      const k = r.productId;
      if (!byProduct.has(k)) byProduct.set(k, []);
      byProduct.get(k).push(r);
    }

    const out = [];
    for (const [productId, raw] of byProduct) {
      raw.sort((a, b) => a.date.localeCompare(b.date));
      const latest = raw[raw.length - 1];

      const lowSeries = raw
        .map((r) => ({ d: r.date, v: num(r.lowPrice) }))
        .filter((p) => p.v != null && p.v > 0);
      if (!lowSeries.length) continue;

      const low = num(latest.lowPrice);
      const market = num(latest.marketPrice);
      const spread = low && market ? ((market - low) / market) * 100 : null;

      // Is the spread widening or tightening over the last ~14 days?
      let spreadTrend = null;
      const spreads = raw
        .map((r) => {
          const l = num(r.lowPrice), m = num(r.marketPrice);
          return l && m ? { d: r.date, v: ((m - l) / m) * 100 } : null;
        })
        .filter(Boolean);
      if (spreads.length >= 10) {
        const recent = spreads.slice(-7).reduce((s, p) => s + p.v, 0) / Math.min(7, spreads.length);
        const prior = spreads.slice(-14, -7);
        if (prior.length) {
          const priorAvg = prior.reduce((s, p) => s + p.v, 0) / prior.length;
          spreadTrend = recent > priorAvg + 1 ? "widening" : recent < priorAvg - 1 ? "tightening" : "stable";
        }
      }

      const d7 = changeOver(lowSeries, 7);
      const d30 = changeOver(lowSeries, 30);
      const d90 = changeOver(lowSeries, 90);
      const vol = volatility(lowSeries);
      const { regime, note } = classify({ d7, d30, d90, spread, spreadTrend, vol });

      const qty = num(latest.qty) ?? 0;
      const cost = num(latest.costBasis);
      const unrealised = cost && low ? ((low - cost) / cost) * 100 : null;

      out.push({
        productId: Number(productId),
        label: latest.label,
        observations: raw.length,
        lowPrice: low,
        marketPrice: market,
        spreadPct: spread == null ? null : +spread.toFixed(1),
        spreadTrend,
        change7d: d7 == null ? null : +d7.toFixed(1),
        change30d: d30 == null ? null : +d30.toFixed(1),
        change90d: d90 == null ? null : +d90.toFixed(1),
        volatilityPct: vol == null ? null : +vol.toFixed(1),
        qty,
        costBasis: cost,
        unrealisedPct: unrealised == null ? null : +unrealised.toFixed(1),
        regime,
        note,
      });
    }

    out.sort((a, b) => (b.change30d ?? -999) - (a.change30d ?? -999));
    await writeFile(OUT, JSON.stringify({ generated: new Date().toISOString(), signals: out }, null, 2));

    const pad = (s, n) => String(s ?? "—").padEnd(n).slice(0, n);
    const rpad = (s, n) => String(s ?? "—").padStart(n);
    console.log(
      pad("PRODUCT", 38) + rpad("LOW", 9) + rpad("7d", 8) + rpad("30d", 8) +
      rpad("SPRD", 7) + " " + "REGIME"
    );
    console.log("-".repeat(96));
    for (const s of out) {
      console.log(
        pad(s.label, 38) +
        rpad(s.lowPrice != null ? "$" + s.lowPrice : "—", 9) +
        rpad(s.change7d != null ? s.change7d + "%" : "—", 8) +
        rpad(s.change30d != null ? s.change30d + "%" : "—", 8) +
        rpad(s.spreadPct != null ? s.spreadPct + "%" : "—", 7) + " " + s.regime
      );
    }
    console.log(`\nWrote ${OUT}`);
  });
}

main();
