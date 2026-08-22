#!/usr/bin/env node
/**
 * Watchlist helper.
 *
 *   node find-products.js                          list categories
 *   node find-products.js pokemon                  list that category's recent sets
 *   node find-products.js pokemon "Prismatic"      list sealed products in matching sets
 *
 * The last form prints watchlist.json-ready lines. Paste them into
 * watchlist.json and fill in qty and costBasis.
 *
 * Read-only. Hits TCGCSV directly, same usage rules as collect.js.
 */

const BASE = "https://tcgcsv.com";
const UA = "NestEgg/1.0.0";
const SLEEP_MS = 150;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const body = await res.json();
  await sleep(SLEEP_MS);
  return body.results ?? [];
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Sealed product heuristic. Singles carry a card Number in extendedData;
 * sealed product does not. Fall back to a keyword match for odd categories.
 */
const SEALED_WORDS =
  /\b(booster|box|bundle|case|collection|tin|blister|pack|etb|elite trainer|deck|display|premium|chest|binder)\b/i;

function isSealed(p) {
  const ext = p.extendedData ?? [];
  const hasNumber = ext.some((e) => norm(e.name) === "number");
  if (hasNumber) return false;
  return SEALED_WORDS.test(p.name ?? "") || !ext.length;
}

async function main() {
  const [catArg, setArg] = process.argv.slice(2);

  const categories = await get(`${BASE}/tcgplayer/categories`);

  if (!catArg) {
    console.log("Categories:\n");
    for (const c of categories.sort((a, b) => a.categoryId - b.categoryId)) {
      console.log(`  ${String(c.categoryId).padStart(4)}  ${c.name}`);
    }
    console.log("\nNext:  node find-products.js <category name>");
    return;
  }

  const want = norm(catArg);
  const category =
    categories.find((c) => norm(c.name) === want) ??
    categories.find((c) => norm(c.displayName) === want) ??
    categories.find((c) => norm(c.name).includes(want));
  if (!category) {
    console.error(`No category matching "${catArg}". Run with no arguments to list them.`);
    process.exit(1);
  }
  console.log(`Category: ${category.name} (categoryId ${category.categoryId})\n`);

  const groups = await get(`${BASE}/tcgplayer/${category.categoryId}/groups`);
  groups.sort((a, b) => String(b.publishedOn ?? "").localeCompare(String(a.publishedOn ?? "")));

  if (!setArg) {
    console.log("Most recent sets:\n");
    for (const g of groups.slice(0, 40)) {
      const when = (g.publishedOn ?? "").slice(0, 10) || "—";
      console.log(`  ${String(g.groupId).padStart(6)}  ${when}  ${g.name}`);
    }
    console.log(`\n${groups.length} sets total.`);
    console.log(`Next:  node find-products.js "${catArg}" "<part of a set name>"`);
    return;
  }

  const needle = norm(setArg);
  const matches = groups.filter(
    (g) => norm(g.name).includes(needle) || norm(g.abbreviation).includes(needle)
  );
  if (!matches.length) {
    console.error(`No set in ${category.name} matching "${setArg}".`);
    console.error("Run without the second argument to see recent sets.");
    process.exit(1);
  }

  for (const g of matches.slice(0, 6)) {
    console.log(`\n=== ${g.name}  (groupId ${g.groupId}, published ${(g.publishedOn ?? "").slice(0, 10)})`);
    let products;
    try {
      products = await get(`${BASE}/tcgplayer/${category.categoryId}/${g.groupId}/products`);
    } catch (err) {
      console.error(`  ! ${err.message}`);
      continue;
    }
    const sealed = products.filter(isSealed);
    if (!sealed.length) {
      console.log("  (no sealed product found in this set)");
      continue;
    }
    console.log("  Paste into watchlist.json -> products:\n");
    for (const p of sealed.sort((a, b) => a.name.localeCompare(b.name))) {
      const line = {
        categoryId: category.categoryId,
        groupId: g.groupId,
        productId: p.productId,
        label: p.name,
        qty: 0,
        costBasis: null,
      };
      console.log("    " + JSON.stringify(line) + ",");
    }
  }
  console.log("\nRemember to set qty and costBasis, and drop the trailing comma on the last entry.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
