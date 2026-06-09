# Grid Trading Simulation

Backtest and Monte Carlo simulation for crypto grid trading strategies. Supports BTC/THB, ETH/THB, and BTC/USDT pairs.

## Features

- **Backtest** — Run grid trading on historical OHLC data with no look-ahead bias
- **Realized vs Total APY** — Separates closed round-trips from mark-to-market unrealized P&L
- **Monte Carlo** — Block bootstrap resampling (300 simulations, 1-year forward)
- **Scenario Analysis** — Base (neutral) and Bull case with configurable annual drift
- **Auto Grid Config** — Sweeps grid count options and picks highest APY automatically
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
    "aggregated_point": ["1748649600", "2532.3", "2540.9", "2504.3", "2520.1", "0", "B2C2"],
    "raw_points": [
      ["1748649600", "2532.3", "2536.1", "2530.1", "2534.6", "0", "B2C2"],
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

Edit `config.json` to change fee rate, backtest period, grid width, simulation parameters, and scenarios.

## Deploy

```bash
# Railway
railway up
```

Ensure `data/` files are available on the server — they are excluded from the repo due to size.
