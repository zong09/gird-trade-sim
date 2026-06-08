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

Place OHLC JSON files in `data/` (not included in repo):

```
data/btc_ohlc_service.hour_ohlc_chart_data.json
data/eth_ohlc_service.hour_ohlc_chart_data.json
data/btc_usdt_ohlc_service.hour_ohlc_chart_data.json
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
