#!/usr/bin/env node
/**
 * NestEgg daily price collector.
 *
 * Pulls lowest-listing / mid / market prices from TCGCSV for every product in
 * watchlist.json and appends a dated row to data/history.csv.
 *
 * Runs server-side (GitHub Actions), so TCGCSV's CORS policy is irrelevant.
 * No API key. No proxy. No cost.
 *
 * Respects TCGCSV usage guidelines:
 *   - custom User-Agent
 *   - checks last-updated.txt before doing any real work
 *   - 100ms between requests
 *   - one group request per unique group, not one per product
 */

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const BASE = "https://tcgcsv.com";
const UA = "NestEgg/1.0.0";
const SLEEP_MS = 150;
const DATA_DIR = "data";
const HISTORY = path.join(DATA_DIR, "history.csv");
const LATEST = path.join(DATA_DIR, "latest.json");
const STATE = path.join(DATA_DIR, ".state.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, { json = true } = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  await sleep(SLEEP_MS);
  return json ? res.json() : res.text();
}

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const force = process.argv.includes("--force");
  await mkdir(DATA_DIR, { recursive: true });

  // 1. Only do work if TCGCSV has actually rebuilt since our last successful pull.
  const stamp = (await get(`${BASE}/last-updated.txt`, { json: false })).trim();
  const state = await readJson(STATE, {});
  if (!force && state.lastUpdated === stamp) {
    console.log(`No new TCGCSV build (${stamp}). Nothing to do.`);
    return;
  }
  console.log(`TCGCSV build: ${stamp}`);

  // 2. Load the watchlist.
  const watchlist = await readJson("watchlist.json", { products: [] });
  const items = watchlist.products ?? [];
  if (!items.length) {
    console.log("watchlist.json is empty. Run find-products.js to populate it.");
    return;
  }

  // 3. One request per unique group, not one per product.
  const groups = new Map();
  for (const it of items) {
    const key = `${it.categoryId}/${it.groupId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  console.log(`${items.length} products across ${groups.size} groups.`);

  const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  const snapshot = [];

  for (const [key, groupItems] of groups) {
    const [categoryId, groupId] = key.split("/");
    let priceRows;
    try {
      const payload = await get(`${BASE}/tcgplayer/${categoryId}/${groupId}/prices`);
      priceRows = payload.results ?? [];
    } catch (err) {
      console.error(`  ! group ${key} failed: ${err.message}`);
      continue;
    }

    // productId is NOT unique on its own — must be composited with subTypeName.
    const byProduct = new Map();
    for (const p of priceRows) {
      if (!byProduct.has(p.productId)) byProduct.set(p.productId, []);
      byProduct.get(p.productId).push(p);
    }

    for (const it of groupItems) {
      const variants = byProduct.get(it.productId) ?? [];
      if (!variants.length) {
        console.warn(`  ? no price row for ${it.productId} (${it.label})`);
        continue;
      }
      // Sealed product is almost always subTypeName "Normal"; take it if the
      // watchlist doesn't pin one explicitly.
      const want = it.subTypeName ?? "Normal";
      const price =
        variants.find((v) => v.subTypeName === want) ?? variants[0];

      const rec = {
        date: today,
        productId: it.productId,
        label: it.label ?? "",
        subTypeName: price.subTypeName,
        lowPrice: price.lowPrice,
        midPrice: price.midPrice,
        highPrice: price.highPrice,
        marketPrice: price.marketPrice,
        directLowPrice: price.directLowPrice,
        qty: it.qty ?? 0,
        costBasis: it.costBasis ?? null,
      };
      rows.push(rec);
      snapshot.push(rec);
      console.log(
        `  ${it.label ?? it.productId}: low ${rec.lowPrice} / mkt ${rec.marketPrice}`
      );
    }
  }

  if (!rows.length) {
    console.log("No prices resolved. Leaving history untouched.");
    return;
  }

  // 4. Append to history. Header only on first write.
  const cols = [
    "date", "productId", "label", "subTypeName",
    "lowPrice", "midPrice", "highPrice", "marketPrice", "directLowPrice",
    "qty", "costBasis",
  ];
  if (!existsSync(HISTORY)) {
    await writeFile(HISTORY, cols.join(",") + "\n");
  }
  const body = rows
    .map((r) => cols.map((c) => csvEscape(r[c])).join(","))
    .join("\n");
  await appendFile(HISTORY, body + "\n");

  // 5. latest.json is what the NestEgg frontend reads (same origin, no CORS).
  await writeFile(
    LATEST,
    JSON.stringify({ date: today, tcgcsvBuild: stamp, products: snapshot }, null, 2)
  );
  await writeFile(STATE, JSON.stringify({ lastUpdated: stamp, lastRun: today }, null, 2));

  console.log(`\nWrote ${rows.length} rows for ${today}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
