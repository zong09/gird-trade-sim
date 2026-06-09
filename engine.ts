import { Candle, GridParams, BacktestResult, AutoGridConfig, WeeklySnapshot } from './types';

const WEEK = 7 * 24 * 3600;

export function resolveGridParams(
  candles: Candle[],
  auto: AutoGridConfig,
  investment: number,
  feeRate = 0.0025,
): { minPrice: number; maxPrice: number; numGrids: number } {
  const { widthPct, numGridsOptions, numGrids: fixedGrids } = auto;

  // Use first candle open price — no look-ahead bias
  const firstPrice = candles[0].open;
  const half    = widthPct / 2 / 100;
  // Auto-calculate roundTo from price magnitude (e.g. 3,000,000 → 1,000 | 65,000 → 10)
  const roundTo = Math.pow(10, Math.floor(Math.log10(firstPrice)) - 3);
  const round   = (v: number) => Math.round(v / roundTo) * roundTo;
  const minPrice = round(firstPrice * (1 - half));
  const maxPrice = round(firstPrice * (1 + half));

  // ถ้าระบุ numGrids ตายตัว → ใช้เลย, ไม่งั้น sweep หา APY สูงสุด
  if (fixedGrids) return { minPrice, maxPrice, numGrids: fixedGrids };

  const results = numGridsOptions.map(numGrids => ({
    numGrids,
    apy: runBacktest(candles, { minPrice, maxPrice, numGrids, investment, feeRate }).apy,
  }));
  const best = results.sort((a, b) => b.apy - a.apy)[0];

  return { minPrice, maxPrice, numGrids: best.numGrids };
}

export function runBacktest(candles: Candle[], params: GridParams): BacktestResult {
  const { minPrice, maxPrice, numGrids, investment, feeRate = 0.0025 } = params;

  const levels = Array.from({ length: numGrids + 1 }, (_, i) =>
    minPrice + (maxPrice - minPrice) * (i / numGrids)
  );
  const cpg = investment / numGrids;
  const pos = levels.slice(0, numGrids).map((_, i) => levels[i + 1] <= candles[0].open);

  let pnl = 0, fees = 0, trades = 0, volume = 0;
  // track avg buy price per grid slot for unrealized P&L calculation
  const buyPrice = levels.slice(0, numGrids).map((_, i) => pos[i] ? levels[i] : 0);
  const snapshots: WeeklySnapshot[] = [];
  const bhQty    = investment / candles[0].open;
  let lastWeekTs = 0;

  const snap = (ts: number, close: number) => {
    snapshots.push({
      date:    new Date(ts * 1000).toISOString().slice(0, 10),
      gridPct: +(pnl / investment * 100).toFixed(3),
      bhPct:   +((bhQty * close - investment) / investment * 100).toFixed(3),
      price:   +close.toFixed(2),
    });
  };

  for (const { ts, high, low, close } of candles) {
    for (let i = 0; i < numGrids; i++) {
      if (pos[i] && high >= levels[i + 1]) {
        const qty = cpg / levels[i];
        const fee = cpg * feeRate + qty * levels[i + 1] * feeRate;
        pnl    += qty * (levels[i + 1] - levels[i]) - fee;
        fees   += fee;
        trades += 2;
        volume += cpg + qty * levels[i + 1];   // buy value + sell value
        pos[i]  = false;
      }
    }
    for (let i = 0; i < numGrids; i++) {
      if (!pos[i] && low <= levels[i]) { pos[i] = true; buyPrice[i] = levels[i]; }
    }
    if (ts - lastWeekTs >= WEEK) { lastWeekTs = ts; snap(ts, close); }
  }
  snap(candles.at(-1)!.ts, candles.at(-1)!.close);

  const endPrice = candles.at(-1)!.close;
  // unrealized P&L: for each grid slot still holding stock, mark to end price
  const unrealized = pos.reduce((sum, holding, i) => {
    if (!holding || buyPrice[i] === 0) return sum;
    const qty = cpg / buyPrice[i];
    const fee = qty * endPrice * feeRate; // hypothetical sell fee
    return sum + qty * (endPrice - buyPrice[i]) - fee;
  }, 0);
  const totalPnl = pnl + unrealized;

  const years   = (candles.at(-1)!.ts - candles[0].ts) / (365.25 * 24 * 3600);
  const spacing = (maxPrice - minPrice) / numGrids;
  const mid     = (minPrice + maxPrice) / 2;

  return {
    minPrice, maxPrice, numGrids, investment, feeRate,
    firstPrice:        +candles[0].open.toFixed(2),
    pnl:               +pnl.toFixed(2),
    fees:              +fees.toFixed(2),
    trades,
    volume:            +volume.toFixed(2),
    apy:               +(pnl / investment / years * 100).toFixed(2),
    unrealized:        +unrealized.toFixed(2),
    totalPnl:          +totalPnl.toFixed(2),
    totalApy:          +(totalPnl / investment / years * 100).toFixed(2),
    spacing:           +spacing.toFixed(0),
    spacingPct:        +(spacing / mid * 100).toFixed(2),
    profitPerRoundTrip:+(spacing / mid * 100 - feeRate * 2 * 100).toFixed(2),
    snapshots,
  };
}
