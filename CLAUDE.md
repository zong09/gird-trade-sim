# Grid Trading Simulation

Grid trading backtest and Monte Carlo simulation for crypto pairs (BTC/THB, ETH/THB, BTC/USDT, etc.).

## Architecture

- **engine.ts** — Core backtest engine. Tracks realized P&L, fees, trades, volume, and unrealized P&L (mark-to-market at end date). Returns both `apy` (realized) and `totalApy` (realized + unrealized).
- **simulator.ts** — Monte Carlo simulation via block bootstrap resampling. Returns percentiles for both realized and total APY (`median`/`p10`…`p90` and `totalMedian`/`totalP10`…`totalP90`). Supports annual drift for bull case scenarios.
- **loader.ts** — Loads and filters OHLC candles from JSON files. Auto-detects 4 input formats.
- **server.ts** — Express API server. Endpoints: `GET /api/config`, `POST /api/run`, `GET /api/files`, `POST /api/files/upload`, `POST /api/files/reorder`, `DELETE /api/files/:filename`.
- **run.ts** — CLI runner for batch backtest + simulation.
- **config.json** — Simulation/backtest parameters (fee rate, periods, grid sweep options, scenarios). Does NOT store assets — those live in `data/asset-config.json`.
- **data/asset-config.json** — Asset registry `{ assets: [{ name, dataFile }] }`. Order here controls the dashboard dropdown order.
- **public/index.html** — Single-file dashboard UI (Chart.js).

## Key Concepts

- **Grid range**: ±widthPct/2% from first candle open price (no look-ahead bias). UI input uses ±% directly (e.g. input 50 → `widthPct: 100` in config).
- **Auto roundTo**: derived from price magnitude — e.g. BTC/THB ~3M → round to 1,000
- **Block bootstrap**: resample 48hr blocks of historical log returns to generate future paths
- **Bull case drift**: `hourlyDrift = ln(1 + annualDrift%) / hoursAhead` added to each log return step
- **Grid center (bull)**: `currentPrice × √(1 + annualDrift%)` — geometric midpoint of expected range. `currentPrice` = last close of simulation training data.
- **Realized APY**: from completed round trips only
- **Total APY**: realized + mark-to-market of open positions at end date
- **Simulation APY**: both realized and total percentiles are computed and shown in table and recommendation cards
- **Capital**: configurable via UI (`simulation.investment`); used for both backtest and simulation. Recommendation cards show est. annual profit for both APY types.
- **Asset order**: controlled by `data/asset-config.json` array order; drag-and-drop in Data Files tab to reorder.

## Setup

```bash
npm install
```

Data files go in `data/` (not in repo). Upload via the browser Data Files tab, or place manually and register in `data/asset-config.json`.

## Usage

### Web dashboard

```bash
npx ts-node server.ts
# → http://localhost:3000
```

### CLI

```bash
npx ts-node run.ts          # all assets
npx ts-node run.ts BTC/THB  # single asset
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
