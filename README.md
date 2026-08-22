# NestEgg — daily price collector

Pulls TCGplayer-sourced sealed product prices from [TCGCSV](https://tcgcsv.com) once a day via GitHub Actions, appends them to a CSV, and computes trend signals.

No API key. No server. No monthly cost. Runs entirely on GitHub's free tier.

## Why it works this way

TCGCSV blocks browser requests (restrictive CORS), which is what killed the original NestEgg build. But a GitHub Action runs server-side, so CORS doesn't apply. It commits the results back into this repo as static JSON, which the NestEgg frontend can then read from the same origin — no proxy needed.

## Setup

1. Push these files to `nonsspace/nestegg` (or a new repo).
2. Find the products you hold:

   ```bash
   node find-products.js                       # list categories
   node find-products.js pokemon               # list recent Pokemon sets
   node find-products.js pokemon "Prismatic"   # list sealed products in that set
   ```

3. Paste the printed lines into `watchlist.json`, filling in `qty` and `costBasis`.
4. Test locally: `node collect.js --force && node analyze.js`
5. Commit. Under repo **Settings → Actions → General**, set **Workflow permissions** to **Read and write**. Then trigger it once by hand from the Actions tab.

After that it runs itself at 21:00 UTC daily.

## Files

| File | Purpose |
| --- | --- |
| `collect.js` | Fetches prices, appends to `data/history.csv`, writes `data/latest.json` |
| `analyze.js` | Reads history, writes `data/signals.json` with trend/spread/regime per product |
| `find-products.js` | Search helper to get productIds into the watchlist |
| `watchlist.json` | What you track, with quantity and cost basis |

## What the signals mean

Prices come as `lowPrice` (true lowest listing), `midPrice` (median listing), and `marketPrice` (TCGplayer's calculated recent-selling value). All analysis runs on `lowPrice`, because it's a real number rather than an average, and it turns before market price does.

| Regime | Meaning |
| --- | --- |
| `uptrend` | 30d and 7d both climbing. Let it run. |
| `uptrend-consolidating` | 30d up, 7d flat. Digesting, not reversing. |
| `uptrend-cooling` | 30d up, 7d rolling over. Watch for a lower high. |
| `bounce` | 30d down, 7d up. Usually a dead-cat bounce, not a bottom. |
| `downtrend` | Both falling. Reprint or oversupply until proven otherwise. |
| `downtrend-basing` | 30d down, 7d flat. Possible base — needs confirmation. |
| `supply-thinning` | Flat price, widening spread. Sellers pulling back — classic pre-run-up setup. |
| `flat` | Move is inside its own noise band. No signal. |

Trend thresholds are scaled to each product's own volatility, so a 5% move on a quiet case counts as signal while the same move on a jumpy box does not.

## What this deliberately does not do

It does not forecast a future price. Sealed markets are thin and event-driven — a reprint announcement or a retailer dumping stock overrides any curve fit. A model trained on a few hundred illiquid points produces confident-looking noise. This classifies what a position is currently doing and flags setups, which is the honest version of the same job.

## Known limitation

TCGCSV does not expose last-sold sales history, only listing prices and TCGplayer's market calculation. Last-sold sits behind TCGplayer's JS app and isn't publicly available. Daily lowest-listing snapshots are the best available proxy — and once you have a few months of them, they're a better dataset than any consumer app will show you.
