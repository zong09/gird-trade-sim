# Grid Trading Simulation

Backtest and Monte Carlo simulation for crypto grid trading strategies. Supports BTC/THB, ETH/THB, BTC/USDT, and any other pair with OHLC data.

## Features

- **Backtest** — Run grid trading on historical OHLC data with no look-ahead bias
- **Realized vs Total APY** — Separates closed round-trips from mark-to-market unrealized P&L; both shown in simulation results and recommendation cards
- **Monte Carlo** — Block bootstrap resampling (configurable simulations, 1-year forward)
- **Scenario Analysis** — Base (neutral) and Bull case with configurable annual drift %; grid center auto-shifts to geometric midpoint of expected range
- **Auto Grid Config** — Sweeps multiple width % and grid count combinations; picks best per scenario
- **Configurable Capital** — Set investment amount in the UI; recommendation cards show estimated annual profit for both realized and total APY
- **Data File Management** — Upload, replace, and delete OHLC files from the browser; drag-and-drop to reorder assets (controls dropdown order)
- **Web Dashboard** — Single-page UI with Chart.js, scenario tabs, and recommendation cards

## Setup

```bash
npm install
```

Place OHLC JSON files in `data/` (not included in repo). File paths are configured in `config.json` under each asset's `dataFile` field.

### Supported JSON formats

The loader auto-detects the format:

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
npx ts-node server.ts
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
