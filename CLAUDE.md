# Grid Trading Simulation

Grid trading backtest and Monte Carlo simulation for crypto pairs (BTC/THB, ETH/THB, BTC/USDT).

## Architecture

- **engine.ts** — Core backtest engine. Runs grid trading simulation on historical candles. Tracks realized P&L, fees, trades, volume, and unrealized P&L (mark-to-market at end date).
- **simulator.ts** — Monte Carlo simulation via block bootstrap resampling. Supports annual drift for bull case scenarios.
- **loader.ts** — Loads and filters OHLC candles from JSON files.
- **server.ts** — Express API server (`/api/config`, `/api/run`, `/api/output/:asset`).
- **run.ts** — CLI runner for batch backtest + simulation.
- **config.json** — All parameters (assets, fee rate, backtest period, simulation settings, scenarios).
- **public/index.html** — Single-file dashboard UI (Chart.js).

## Key Concepts

- **Grid range**: ±widthPct/2% from first candle open price (no look-ahead bias)
- **Auto roundTo**: derived from price magnitude — e.g. BTC/THB ~3M → round to 1,000
- **Block bootstrap**: resample 48hr blocks of historical log returns to generate future paths
- **Bull case drift**: `hourlyDrift = ln(1 + annualDrift%) / hoursAhead` added to each log return step
- **Grid center (bull)**: `currentPrice × √(1 + annualDrift%)` — geometric midpoint of expected range
- **Realized APY**: from completed round trips only
- **Total APY**: realized + mark-to-market of open positions at end date

## Setup

```bash
npm install
```

### Data files

Place OHLC JSON files in `data/` (not included in repo):

```
data/btc_ohlc_service.hour_ohlc_chart_data.json
data/eth_ohlc_service.hour_ohlc_chart_data.json
data/btc_usdt_ohlc_service.hour_ohlc_chart_data.json
```

Expected format: array of objects with `{ open_time, open, high, low, close }` or similar — see `loader.ts` for exact field mapping.

## Usage

### Web dashboard

```bash
npx ts-node server.ts
# → http://localhost:3000
```

### CLI

```bash
# All assets
npx ts-node run.ts

# Single asset
npx ts-node run.ts BTC/THB
```

## Config

Edit `config.json` to change:
- Assets and data file paths
- Fee rate
- Backtest period
- Grid width % and number of grids
- Simulation parameters (numSims, hoursAhead, blockSize)
- Scenarios (Base drift=0, Bull drift=X%)
