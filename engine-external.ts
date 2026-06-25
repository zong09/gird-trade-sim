import { Candle, GridParams, BacktestResult, WeeklySnapshot } from './types';

// External "touch-based" grid model — faithful port of grid_engine.py::backtest from
// haruhanniti-alt/Grid_code. Differs from the crossing model (engine.ts) in three core ways:
//   1. Fills on level *touch* within a candle's range, not on a directional cross of prev close.
//   2. Every slot starts EMPTY (no pre-seeded inventory below the open price).
//   3. Capital is wallet-gated — a buy is skipped when cash is insufficient.
// `numGrids` is interpreted as the external model's grid_levels (number of price *levels*),
// so the spacing uses (numGrids - 1). Uses counters instead of a per-trade list so Monte Carlo
// stays fast; the numbers match the Python engine.

export function runBacktestExternal(candles: Candle[], params: GridParams): BacktestResult {
  const { minPrice, maxPrice, numGrids, investment, feeRate = 0.0025, slippage = 0, skipSnapshots = false } = params;

  const levelCount = numGrids;                       // external grid_levels
  const step = (maxPrice - minPrice) / (levelCount - 1);
  const levels = Array.from({ length: levelCount }, (_, i) => minPrice + i * step);
  const stakePerSlot = investment / levelCount;

  const ref = candles[0].open;
  let wallet = investment;
  const held     = new Array(levelCount).fill(false);
  const slotCost = new Array(levelCount).fill(0);
  const slotQty  = new Array(levelCount).fill(0);

  let pnl = 0, fees = 0, tradeCount = 0, volume = 0, buyVolume = 0, sellVolume = 0;
  let firstMatchPrice = 0;

  const snapshots: WeeklySnapshot[] = [];
  let prevDate = '';

  for (const [ci, { ts, high, low, open, close }] of candles.entries()) {
    // ── Pass 1: SELL — slot i sells at its upper level when high reaches it ──
    for (let i = 0; i < levelCount - 1; i++) {
      const sellLevel = levels[i + 1];
      if (held[i] && high >= sellLevel) {
        const execPrice = Math.max(sellLevel, open);   // gap up → fill at open
        const sp = execPrice * (1 - slippage);
        const revenue = slotQty[i] * sp;
        const fee = revenue * feeRate;
        pnl    += revenue - fee - slotCost[i];
        wallet += revenue - fee;
        fees   += fee;
        tradeCount++;
        volume += revenue; sellVolume += revenue;
        held[i] = false; slotCost[i] = 0; slotQty[i] = 0;
        if (ci > 0 && !firstMatchPrice) firstMatchPrice = sp;
      }
    }
    // ── Pass 2: BUY — slot i buys at its level when the candle range touches it ──
    for (let i = 0; i < levelCount; i++) {
      const buyLevel = levels[i];
      if (!held[i] && low <= buyLevel && buyLevel <= high && wallet >= stakePerSlot) {
        const bp = buyLevel * (1 + slippage);
        const qty = (stakePerSlot * (1 - feeRate)) / bp;
        const fee = stakePerSlot * feeRate;
        wallet -= stakePerSlot;
        held[i] = true; slotCost[i] = stakePerSlot; slotQty[i] = qty;
        fees   += fee;
        tradeCount++;
        volume += qty * bp; buyVolume += qty * bp;
        if (ci > 0 && !firstMatchPrice) firstMatchPrice = bp;
      }
    }
    // ── Daily snapshot (equity-based, like grid_engine.py) ──
    if (!skipSnapshots) {
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      if (date !== prevDate) {
        prevDate = date;
        let heldVal = 0;
        for (let i = 0; i < levelCount; i++) if (held[i]) heldVal += slotQty[i] * close;
        snapshots.push({
          date,
          gridPct: +((wallet + heldVal - investment) / investment * 100).toFixed(3),
          bhPct:   +((close - ref) / ref * 100).toFixed(3),
          price:   +close.toFixed(2),
        });
      }
    }
  }

  // ── End: mark held slots to last close ──
  const endPrice = candles.at(-1)!.close;
  let heldVal = 0, heldCost = 0;
  for (let i = 0; i < levelCount; i++) {
    if (held[i]) { heldVal += slotQty[i] * endPrice; heldCost += slotCost[i]; }
  }
  const unrealized = heldVal - heldCost;
  const totalPnl = pnl + unrealized;

  // Match grid_engine.py: years = ((last - first).days + 1) / 365.25 — whole calendar
  // days, inclusive of both endpoints. Differs from an exact-seconds divide by up to ~1 day.
  const days    = Math.floor((candles.at(-1)!.ts - candles[0].ts) / 86400) + 1;
  const years   = days / 365.25;
  const spacingPct = step / minPrice * 100;   // external uses grid_min as denominator

  return {
    model: 'external',
    minPrice, maxPrice, numGrids, investment, feeRate, slippage,
    firstPrice:        +ref.toFixed(2),
    firstMatchPrice:   +(firstMatchPrice || ref).toFixed(2),
    pnl:               +pnl.toFixed(2),
    fees:              +fees.toFixed(2),
    trades:            tradeCount,
    volume:            +volume.toFixed(2),
    buyVolume:         +buyVolume.toFixed(2),
    sellVolume:        +sellVolume.toFixed(2),
    apy:               +(pnl / investment / years * 100).toFixed(2),
    unrealized:        +unrealized.toFixed(2),
    totalPnl:          +totalPnl.toFixed(2),
    totalApy:          +(totalPnl / investment / years * 100).toFixed(2),
    totalReturnPct:    +(totalPnl / investment * 100).toFixed(2),
    spacing:           +step.toFixed(0),
    spacingPct:        +spacingPct.toFixed(2),
    // Sensible round-trip edge (gross spacing minus both-side fees + slippage). NOT the Python
    // engine's `profit_per_grid = spacing_pct*2*fee*100`, which is mislabeled / not a real metric.
    profitPerRoundTrip:+(spacingPct - feeRate * 2 * 100 - slippage * 2 * 100).toFixed(2),
    snapshots,
  };
}
