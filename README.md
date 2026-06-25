# Grid Trading Simulation

Backtest and Monte Carlo simulation for crypto grid trading strategies. Supports BTC/THB, ETH/THB, BTC/USDT, and any other pair with OHLC data.

## Features

- **Backtest** — Run grid trading on historical OHLC data with no look-ahead bias
- **Two fill models** (chosen at runtime via `BACKTEST_MODEL`):
  - **`external`** (default, touch-based) — faithful port of `grid_engine.py`: every slot starts empty, a buy fills when the candle range touches a level (`low ≤ level ≤ high`) and cash is available (wallet-gated), a sell fills when `high` reaches the slot's upper level (gap-up fills at open). `numGrids` = number of price *levels*.
  - **`crossing`** — orders fill only on a genuine price crossing: a buy on a downward cross (price was above the level, then dipped to it), a sell on an upward cross. Levels the price never traded through are never filled, so no phantom inventory or fake mark-to-market loss.
  - The active model is recorded in `BacktestResult.model`, logged to the server console, and shown in the dashboard footer.
- **Buy / sell volume breakdown** — Trading Volume reports total notional plus the buy and sell split (`buyVolume` / `sellVolume`); total fees ≈ `feeRate × volume`
- **Save & replay runs** — Persist a backtest result with the dashboard "Save run" button; the History tab lists saved runs and can reload one (replaying the cards + returns chart) or delete it. Stored in SQLite (`backtest_runs`), backtest only, ~5KB/run
- **Realized vs Total APY** — Separates closed round-trips from mark-to-market unrealized P&L; both shown in simulation results and recommendation cards
- **Monte Carlo** — Block bootstrap resampling (configurable simulations, 1-year forward)
- **Scenario Analysis** — Base (neutral) and Bull case with configurable annual drift %; grid center auto-shifts to geometric midpoint of expected range
- **Auto Grid Config** — Sweeps multiple width % and grid count combinations; picks best per scenario
- **Configurable Capital** — Set investment amount in the UI; recommendation cards show estimated annual profit for both realized and total APY
- **SQLite candle store** — All candles live in `data/candles.db` (better-sqlite3), keyed by asset name; backtest/sim query only the needed date range instead of parsing whole files
- **Binance sync** — Search any Binance pair and pull monthly klines from data.binance.vision straight into the DB, with live progress (CLI or a "Sync" button in the dashboard)
- **Data management** — Upload `.json` or `.csv` (header-aware, e.g. Bitkub), delete assets, drag-and-drop to reorder (controls dropdown order)
- **SSE streaming run** — `POST /api/run/stream` streams backtest + simulation progress as Server-Sent Events with a live % progress bar; avoids Cloudflare's 100s origin timeout (524) on long runs
- **Processing-time logs** — backtest and simulation each log their elapsed time (ms) to the server console / CLI output, so you can spot bottlenecks per run
- **Fast Monte Carlo** — simulation reuses candle arrays across paramSets and skips per-day snapshot building in the inner backtests (results identical), cutting allocation/GC overhead on CPU-bound runs
- **Web Dashboard** — Single-page UI with Chart.js, scenario tabs, recommendation cards, and live % progress bar during runs

## Setup

```bash
npm install   # builds better-sqlite3; needs curl + unzip on PATH for Binance sync
```

> **Production note**: `ts-node` and all `@types/*` packages are in `dependencies` (not devDependencies) so `npm install --omit=dev` / `npm ci --production` still installs them — the server runs directly from TypeScript source via `npm run server`. Only `typescript` itself stays in devDependencies.

Candles are stored in `data/candles.db` (gitignored). Load data by:

- **Sync from Binance** — Data Files tab → search a pair → pick interval + month range → Sync. Or CLI:
  ```bash
  npx ts-node fetch-binance.ts BTCUSDT 1m 2024-06 2026-05 --name "BTC/USDT 1m"
  ```
- **Upload** a `.json` or `.csv` file in the Data Files tab.
- **Migrate** legacy JSON-file assets listed in `data/asset-config.json`: `npx ts-node migrate-to-sqlite.ts`

### Supported upload formats

**CSV** — any file with a header row exposing a time column (`timestamp`/`ts`/`time`/`date`) plus `open,high,low,close` (e.g. Bitkub exports). Timestamps in seconds/ms/μs are normalized automatically.

**JSON** — the loader auto-detects 4 formats:

**Format 1 — aggregated_point** (hourly candle with nested minute raw_points)
```json
[
  {
    "timestamp": { "$numberLong": "1748649600" },
    "aggregated_point": ["1748649600", "2532.3", "2540.9", "2504.3", "2520.1", "0", "BINANCE"],
    "raw_points": [
      ["1748649600", "2532.3", "2536.1", "2530.1", "2534.6", "0", "BINANCE"],
      ...
    ]
  }
]
```
Fields: `[timestamp, open, high, low, close, volume, exchange]`

**Format 2 — raw_points only** (array of minute candles per record)
```json
[{ "raw_points": [["ts", "open", "high", "low", "close"], ...] }]
```

**Format 3 — flat array of arrays**
```json
[["ts", "open", "high", "low", "close"], ...]
```

**Format 4 — flat array of Candle objects**
```json
[{ "ts": 1234567890, "open": 100, "high": 105, "low": 99, "close": 102 }]
```

## Usage

**Web dashboard**
```bash
npm run server        # preferred (uses pinned ts-node version)
# → http://localhost:3000
```

**CLI**
```bash
npx ts-node run.ts          # all assets
npx ts-node run.ts BTC/THB  # single asset
```

## Config

Most settings are editable directly from the dashboard sidebar. `config.json` is the persistent store — edited on save or run.

Key fields:
- `feeRate` — maker/taker fee per side (e.g. `0.0025` = 0.25%)
- `backtest.period` — start/end dates for historical backtest
- `backtest.auto.widthPct` — total grid range as % of first candle price (UI shows ±half, e.g. input 50 → widthPct 100 → ±50%)
- `simulation.investment` — capital used for both backtest and simulation
- `simulation.autoParamSets.widthPcts` — array of total widths swept in simulation (e.g. `[40,60,80,100,120]`)
- `simulation.autoParamSets.numGridsOptions` — array of grid counts swept (e.g. `[20,30,40,50]`)
- `simulation.scenarios` — list of `{ label, annualDrift }` objects; `annualDrift: 0` = Base, `annualDrift: 80` = Bull +80%
