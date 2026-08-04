# Grid Trading Simulation

Grid trading backtest and Monte Carlo simulation for crypto pairs (BTC/THB, ETH/THB, BTC/USDT, etc.).

## Architecture

- **engine.ts** — Core backtest engine. Tracks realized P&L, fees, trades, volume, and unrealized P&L (mark-to-market at end date). Returns both `apy` (realized) and `totalApy` (realized + unrealized).
- **simulator.ts** — Monte Carlo simulation via block bootstrap resampling. Returns percentiles for both realized and total APY (`median`/`p10`…`p90` and `totalMedian`/`totalP10`…`totalP90`). Supports annual drift for bull case scenarios. `runMonteCarlo` is **async**: it yields (`setImmediate`) between paramSets so the caller's SSE writes can flush, and reports per-paramSet progress via an optional `onProgress(done, total)` callback.
- **walkforward.ts** — Rolling-window (walk-forward) backtest. `generateWindows(firstTs, lastTs, windowMonths)` slides a fixed-length window 1 month at a time across an asset's full candle history (inclusive end, stops once a window would exceed the last available candle). `runWalkForward(cfg, asset, windowMonths, options, onProgress?)` dispatches one backtest per window to a pool of `worker_threads` (see `walkforward-worker.ts`) — pool size = all CPU cores, capped at window count, since each window is fully independent this parallelizes with no shared state. Tags each period pass/fail against optional `targetApy` (annualized %) / `targetProfit` (checked against `totalReturnPct` — total return %, non-annualized; AND logic if both set), and returns per-period results plus summary stats. `options.startDate` overrides the window-generation start but is clamped to the asset's real first candle.
- **walkforward-worker.ts** — The `worker_threads` entry point spawned by `walkforward.ts`. Runs one window's `loadCandles`/`resolveGridParams`/`runBacktest` in isolation (own SQLite connection — safe under WAL's multi-reader support) and posts back `{index, period}` or `{index, error}` so the pool can reassemble results in chronological order regardless of completion order.
- **db.ts** — SQLite store (`better-sqlite3`). Table `candles(symbol, ts, open, high, low, close)` PK `(symbol, ts)`. `insertCandles` (INSERT OR IGNORE dedup), `queryCandles` (range by period), `listSymbols`, `deleteSymbol`. Also table `backtest_runs` (saved backtest results: summary columns + `result_json` blob holding the full `BacktestResult`) with `saveBacktestRun`, `listBacktestRuns`, `getBacktestRun`, `deleteBacktestRun`. DB file: `data/candles.db`.
- **loader.ts** — `loadCandles(symbol, period)` reads from SQLite by date range. `parseCandleData` (4 JSON formats) + `parseCsvData` (header-aware CSV, e.g. Bitkub) + `validateCandles` — used for import/upload only.
- **binance.ts** — Binance integration. `searchSymbols` (cached exchangeInfo) + `syncKlines` (downloads monthly klines from data.binance.vision via curl+unzip, normalizes ts to seconds, inserts to DB). CSV cache: `data/binance/{SYMBOL}/{INTERVAL}/`.
- **fetch-binance.ts** — CLI wrapper over `binance.syncKlines`.
- **migrate-to-sqlite.ts** — One-time import of legacy JSON-file assets into the DB.
- **server.ts** — Express API. Endpoints: `GET /api/config` (also reports `model` from `backtestModel()`), `POST /api/run` (blocking JSON — backward-compat/CLI), `POST /api/run/stream` (**SSE**: `start`→`progress`→`done`/`error`; the dashboard uses this), `POST /api/walkforward/stream` (**SSE**: rolling-window backtest via `walkforward.ts`, same event shape but `progress` is `{done,total}` = windows completed), `POST /api/runs` (save a backtest run), `GET /api/runs` (list saved runs), `GET /api/runs/:id` (load one in full), `DELETE /api/runs/:id`, `GET /api/files` (DB-backed asset list, also used to default the Walk-Forward tab's start-period field), `POST /api/files/upload` (.json/.csv → DB), `POST /api/files/reorder`, `DELETE /api/files/:name`, `GET /api/binance/symbols`, `GET /api/binance/sync` (SSE progress), `GET /api/sysmetrics` (CPU/RAM/uptime for the monitor page), `GET /api/logs` (list day-log files) and `GET /api/logs/:date?lines=N` (tail, default 500/max 5000 — both back the monitor page's log viewer). Shared helper `executeRun(cfg, asset, onProgress?)` runs backtest + Monte Carlo for both run endpoints.
- **run.ts** — CLI runner for batch backtest + simulation.
- **config.json** — Simulation/backtest parameters (fee rate, periods, grid sweep options, scenarios). Does NOT store assets — those live in `data/asset-config.json`.
- **data/asset-config.json** — Asset registry `{ assets: [{ name, dataFile? }] }`. Order controls dashboard dropdown order. Candles live in SQLite by `name`; `dataFile` is legacy/optional.
- **public/index.html** — Single-file dashboard UI (Chart.js). Dashboard tab has a "Save run" button (persists the current backtest). History tab lists saved runs and can Load (replay backtest cards + returns chart) or Delete. Data Files tab has Binance crypto search + Sync button, JSON/CSV upload, and drag-reorder. Walk-Forward tab configures asset/window months/grid count/start period/target APY (%)/target PL (%, checked against `totalReturnPct`), streams `/api/walkforward/stream`, and renders a KPI summary + one row per rolling period (APY, total APY, PNL, total PNL, total return %, capital turnover, price range, Met/Missed target badge). Footer shows version + active backtest model from `GET /api/config`.
- **public/monitor.html** — System monitor page. CPU/RAM/process-RSS/uptime cards + rolling 5-min charts, polling `GET /api/sysmetrics` every 2s. Logs section: date picker + tail viewer (`GET /api/logs`, `GET /api/logs/:date`), auto-refreshing every 5s only while viewing the most recent (actively growing) day's file. Same footer as the dashboard.
- **logger.ts** — Patches `console.log/info/warn/error` to also append to a daily file `data/logs/YYYY-MM-DD.log` (30-day retention, auto-cleaned). `requestLogger` middleware logs every request's `method url status durationMs` — except paths under `/api/logs` and `/api/sysmetrics`, which are polled every few seconds by the monitor page and would otherwise spam the very log being viewed. `listLogFiles()` / `readLogFile(date, maxLines)` back the monitor page's log viewer; `date` is validated against `YYYY-MM-DD` before it ever touches the filesystem.

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
- **Walk-forward / rolling-window backtest**: slides a `windowMonths`-long backtest 1 month at a time across an asset's full history (fixed step, not user-configurable) — window `i` is `[firstDate + i months, firstDate + i months + windowMonths months - 1 day]`, so consecutive windows overlap heavily; stops once a window's end exceeds the last available candle. Each window is independent: grid range/count resolved fresh from that window's own first candle (no look-ahead across windows), capital resets to `simulation.investment` every window (no compounding). Windows run in parallel on a `worker_threads` pool sized to all CPU cores (capped at window count — see `walkforward.ts`/`walkforward-worker.ts`); backtest-only (no Monte Carlo) to keep large sweeps fast. `targetApy` (annualized %) and `targetProfit` (total return %, i.e. `totalReturnPct` — non-annualized, **not** the absolute `totalPnl`) are optional per-run inputs (not stored in `config.json`); a period "meets target" only if it clears every target that's set (AND, not OR). "Start Period" defaults to the asset's oldest candle but can be pushed later; clamped server-side so it can never precede real data.

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
