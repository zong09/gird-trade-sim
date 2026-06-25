# Grid Trading Simulation

Grid trading backtest and Monte Carlo simulation for crypto pairs (BTC/THB, ETH/THB, BTC/USDT, etc.).

## Architecture

- **engine.ts** — Core backtest engine. Tracks realized P&L, fees, trades, volume, and unrealized P&L (mark-to-market at end date). Returns both `apy` (realized) and `totalApy` (realized + unrealized).
- **simulator.ts** — Monte Carlo simulation via block bootstrap resampling. Returns percentiles for both realized and total APY (`median`/`p10`…`p90` and `totalMedian`/`totalP10`…`totalP90`). Supports annual drift for bull case scenarios. `runMonteCarlo` is **async**: it yields (`setImmediate`) between paramSets so the caller's SSE writes can flush, and reports per-paramSet progress via an optional `onProgress(done, total)` callback.
- **db.ts** — SQLite store (`better-sqlite3`). Table `candles(symbol, ts, open, high, low, close)` PK `(symbol, ts)`. `insertCandles` (INSERT OR IGNORE dedup), `queryCandles` (range by period), `listSymbols`, `deleteSymbol`. Also table `backtest_runs` (saved backtest results: summary columns + `result_json` blob holding the full `BacktestResult`) with `saveBacktestRun`, `listBacktestRuns`, `getBacktestRun`, `deleteBacktestRun`. DB file: `data/candles.db`.
- **loader.ts** — `loadCandles(symbol, period)` reads from SQLite by date range. `parseCandleData` (4 JSON formats) + `parseCsvData` (header-aware CSV, e.g. Bitkub) + `validateCandles` — used for import/upload only.
- **binance.ts** — Binance integration. `searchSymbols` (cached exchangeInfo) + `syncKlines` (downloads monthly klines from data.binance.vision via curl+unzip, normalizes ts to seconds, inserts to DB). CSV cache: `data/binance/{SYMBOL}/{INTERVAL}/`.
- **fetch-binance.ts** — CLI wrapper over `binance.syncKlines`.
- **migrate-to-sqlite.ts** — One-time import of legacy JSON-file assets into the DB.
- **server.ts** — Express API. Endpoints: `GET /api/config`, `POST /api/run` (blocking JSON — backward-compat/CLI), `POST /api/run/stream` (**SSE**: `start`→`progress`→`done`/`error`; the dashboard uses this), `POST /api/runs` (save a backtest run), `GET /api/runs` (list saved runs), `GET /api/runs/:id` (load one in full), `DELETE /api/runs/:id`, `GET /api/files` (DB-backed asset list), `POST /api/files/upload` (.json/.csv → DB), `POST /api/files/reorder`, `DELETE /api/files/:name`, `GET /api/binance/symbols`, `GET /api/binance/sync` (SSE progress). Shared helper `executeRun(cfg, asset, onProgress?)` runs backtest + Monte Carlo for both run endpoints.
- **run.ts** — CLI runner for batch backtest + simulation.
- **config.json** — Simulation/backtest parameters (fee rate, periods, grid sweep options, scenarios). Does NOT store assets — those live in `data/asset-config.json`.
- **data/asset-config.json** — Asset registry `{ assets: [{ name, dataFile? }] }`. Order controls dashboard dropdown order. Candles live in SQLite by `name`; `dataFile` is legacy/optional.
- **public/index.html** — Single-file dashboard UI (Chart.js). Dashboard tab has a "Save run" button (persists the current backtest). History tab lists saved runs and can Load (replay backtest cards + returns chart) or Delete. Data Files tab has Binance crypto search + Sync button, JSON/CSV upload, and drag-reorder.

## Key Concepts

- **Grid range**: ±widthPct/2% from first candle open price (no look-ahead bias). UI input uses ±% directly (e.g. input 50 → `widthPct: 100` in config).
- **Saved runs**: a backtest result can be persisted via the dashboard "Save run" button → `POST /api/runs` → `backtest_runs` table. Stores the **backtest only** (no simulation), ~5KB/run (one row; `result_json` grows with number of days, not trades). Load from the History tab replays the backtest cards + returns chart; `renderDashboard` guards on `hasSim` so a loaded run (empty `scenarios`) skips the Monte Carlo section.
- **Backtest model (`BACKTEST_MODEL` env)**: two fill models, chosen at runtime. Default **`external`** (touch-based, ports `haruhanniti-alt/Grid_code/grid_engine.py`, in `engine-external.ts`); set `BACKTEST_MODEL=crossing` for the original crossing model (`engine.ts`). `runBacktest` in `engine.ts` is a dispatcher; the chosen model is recorded in `BacktestResult.model` and logged. External: empty-start, wallet-gated (skips buys when cash is short), touch-fill (`low<=level<=high`), gap-up sell at open, equity-based snapshots, and `numGrids` = number of price *levels*.
- **Order fills (crossing model)**: a buy fills only on a downward cross (`prevRef > level && low <= level`), a sell only on an upward cross (`prevRef < level && high >= level`), where `prevRef` is the previous candle's close. Levels the price never traded through are never filled — prevents phantom inventory bought at untraded prices (the bug fixed on `feature/fix-backtest-logic`).
- **Auto roundTo**: derived from price magnitude — e.g. BTC/THB ~3M → round to 1,000
- **Block bootstrap**: resample 48hr blocks of historical log returns to generate future paths
- **Bull case drift**: `hourlyDrift = ln(1 + annualDrift%) / hoursAhead` added to each log return step
- **Grid center (bull)**: `currentPrice × √(1 + annualDrift%)` — geometric midpoint of expected range. `currentPrice` = last close of simulation training data.
- **Realized APY**: from completed round trips only
- **Total APY**: realized + mark-to-market of open positions at end date
- **Simulation APY**: both realized and total percentiles are computed and shown in table and recommendation cards
- **Capital**: configurable via UI (`simulation.investment`); used for both backtest and simulation. Recommendation cards show est. annual profit for both APY types.
- **Asset order**: controlled by `data/asset-config.json` array order; drag-and-drop in Data Files tab to reorder.
- **Candle store**: all candles in `data/candles.db` (SQLite), keyed by asset name. Backtest/sim query only the needed date range — no full-file parse.
- **Data sources**: (1) UI **Sync from Binance** — search a pair, pick interval + month range → downloads from data.binance.vision; (2) **Upload** a `.json` or `.csv` (header-aware, e.g. Bitkub) in the Data Files tab; (3) CLI `fetch-binance.ts`.
- **ts unit**: stored as **seconds**. Binance klines (μs/ms) are normalized on import.

## Setup

```bash
npm install   # builds better-sqlite3 (needs curl + unzip on PATH for Binance sync)
```

Candles live in `data/candles.db` (gitignored). Get data via the UI **Sync from Binance** / **Upload** (.json/.csv), or migrate legacy JSON files with `npx ts-node migrate-to-sqlite.ts`.

## Usage

### Web dashboard

```bash
npm run server        # preferred for production (uses pinned ts-node from dependencies)
# → http://localhost:3000
```

### CLI

```bash
npx ts-node run.ts          # all assets
npx ts-node run.ts BTC/THB  # single asset (case-insensitive)
```

### Sync data from Binance (CLI)

```bash
npx ts-node fetch-binance.ts BTCUSDT 1m 2024-06 2026-05 --name "BTC/USDT 1m"
```

## Config

Most settings editable from the dashboard sidebar (changes apply per-run, not persisted to config.json).

- `feeRate` — fee per side (e.g. 0.0025 = 0.25%)
- `backtest.period` — start/end dates
- `backtest.auto.widthPct` — total range width; UI shows ±half
- `simulation.investment` — capital for backtest and simulation
- `simulation.autoParamSets.widthPcts` — widths swept in simulation (total %, e.g. [40,60,80,100,120])
- `simulation.autoParamSets.numGridsOptions` — grid counts swept (e.g. [20,30,40,50])
- `simulation.scenarios` — `[{ label, annualDrift }]`; annualDrift 0 = Base, 80 = Bull +80%
