import { Candle, ParamSet, SimResult, Recommendation, AutoParamSets } from './types';

export function autoGenParamSets(candles: Candle[], opts: AutoParamSets, annualDrift = 0): ParamSet[] {
  const currentPrice = candles.at(-1)!.close;
  // Bull case: shift center upward using geometric midpoint of drift
  // √(1 + drift%) ≈ expected price at mid-year → grid covers where price will actually trade
  const center = annualDrift > 0
    ? currentPrice * Math.sqrt(1 + annualDrift / 100)
    : currentPrice;

  const round = (v: number) => {
    const mag = Math.pow(10, Math.floor(Math.log10(v)) - 1);
    return Math.round(v / mag) * mag;
  };

  const sets: ParamSet[] = [];
  for (const widthPct of opts.widthPcts) {
    const half     = widthPct / 2 / 100;
    const minPrice = round(center * (1 - half));
    const maxPrice = round(center * (1 + half));
    for (const numGrids of opts.numGridsOptions) {
      sets.push({ label: `±${widthPct / 2}% g${numGrids}`, minPrice, maxPrice, numGrids });
    }
  }
  return sets;
}
import { runBacktest } from './engine';

interface MonteCarloOptions {
  candles: Candle[];
  paramSets: ParamSet[];
  investment?: number;
  feeRate?: number;
  numSims?: number;
  hoursAhead?: number;
  blockSize?: number;
  seed?: number;
  annualDrift?: number;  // % เช่น 0 = neutral, 80 = +80%/ปี
}

interface RecommendationOptions {
  targetApy?: number;
  targetProfit?: number | null;
  strategy?: 'balanced' | 'safe' | 'aggressive';
}

function rand(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toHourly(candles: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of candles) {
    const h = Math.floor(c.ts / 3600) * 3600;
    if (!map.has(h)) {
      map.set(h, { ...c, ts: h });
    } else {
      const b = map.get(h)!;
      if (c.high > b.high) b.high = c.high;
      if (c.low  < b.low)  b.low  = c.low;
      b.close = c.close;
    }
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

function percentile(sorted: number[], p: number): number {
  const i  = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function runMonteCarlo({
  candles,
  paramSets,
  investment  = 100_000,
  feeRate     = 0.0025,
  numSims     = 300,
  hoursAhead  = 8760,
  blockSize   = 48,
  seed        = 42,
  annualDrift = 0,
}: MonteCarloOptions): SimResult[] {
  const hourly = toHourly(candles);
  const closes = hourly.map(c => c.close);

  const logRet = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const hlHigh = hourly.slice(1).map((c, i) => c.high / closes[i + 1]);
  const hlLow  = hourly.slice(1).map((c, i) => c.low  / closes[i + 1]);

  const r           = rand(seed);
  const start       = closes.at(-1)!;
  const n           = logRet.length;
  // hourly drift: ln(1 + drift%) / 8760  →  compounds to annualDrift% over 1 year
  const hourlyDrift = annualDrift !== 0 ? Math.log(1 + annualDrift / 100) / hoursAhead : 0;

  // Generate simulated paths via block bootstrap
  const paths = Array.from({ length: numSims }, () => {
    const ret: number[] = [], hi: number[] = [], lo: number[] = [];
    while (ret.length < hoursAhead) {
      const s    = Math.floor(r() * (n - blockSize));
      const take = Math.min(blockSize, hoursAhead - ret.length);
      for (let j = 0; j < take; j++) {
        ret.push(logRet[s + j] + hourlyDrift);   // บวก drift ทุก step
        hi.push(hlHigh[s + j]);
        lo.push(hlLow[s + j]);
      }
    }
    const prices = [start];
    for (let i = 0; i < hoursAhead; i++) prices.push(prices[i] * Math.exp(ret[i]));
    return { prices, hi, lo };
  });

  return paramSets.map(ps => {
    const results = paths.map(({ prices, hi, lo }) => {
      const c: Candle[] = prices.slice(1).map((p, i) => ({
        ts: i * 3600, open: prices[i], high: p * hi[i], low: p * lo[i], close: p,
      }));
      const r = runBacktest(c, { ...ps, investment, feeRate });
      return { apy: r.apy, trades: r.trades };
    });
    const apys   = results.map(r => r.apy).sort((a, b) => a - b);
    const trades = results.map(r => r.trades);
    const avgTrades = +(trades.reduce((s, v) => s + v, 0) / trades.length).toFixed(0);

    const spacing = (ps.maxPrice - ps.minPrice) / ps.numGrids;
    const mid     = (ps.minPrice + ps.maxPrice) / 2;

    return {
      label:             ps.label ?? `${ps.minPrice / 1e6}M–${ps.maxPrice / 1e6}M g${ps.numGrids}`,
      minPrice:          ps.minPrice,
      maxPrice:          ps.maxPrice,
      numGrids:          ps.numGrids,
      median:            +percentile(apys, 50).toFixed(2),
      p10:               +percentile(apys, 10).toFixed(2),
      p25:               +percentile(apys, 25).toFixed(2),
      p75:               +percentile(apys, 75).toFixed(2),
      p90:               +percentile(apys, 90).toFixed(2),
      probAboveTarget:   +(apys.filter(v => v >= 8).length / apys.length * 100).toFixed(1),
      probPositive:      +(apys.filter(v => v >  0).length / apys.length * 100).toFixed(1),
      avgTradesPerYear:  avgTrades,
      profitPerRoundTrip:+(spacing / mid * 100 - feeRate * 2 * 100).toFixed(2),
    };
  });
}

export function getRecommendation(
  results: SimResult[],
  { targetApy = 8, targetProfit = null, strategy = 'balanced' }: RecommendationOptions = {}
): Recommendation {
  const aboveTarget = results.filter(r => r.median >= targetApy);
  const sorted: Record<string, SimResult[]> = {
    // closest median to target (prefer slightly above)
    balanced:   [...results].sort((a, b) => Math.abs(a.median - targetApy) - Math.abs(b.median - targetApy)),
    // highest P10 (best worst-case) among configs where median >= target
    safe:       (aboveTarget.length ? aboveTarget : results).sort((a, b) => b.p10 - a.p10),
    // highest median
    aggressive: [...results].sort((a, b) => b.median - a.median),
  };

  const best    = (sorted[strategy] ?? sorted.balanced)[0];
  const spacing = (best.maxPrice - best.minPrice) / best.numGrids;
  const mid     = (best.minPrice + best.maxPrice) / 2;
  const inv     = targetProfit ? Math.ceil(targetProfit / (best.median / 100) / 1000) * 1000 : null;

  return {
    strategy,
    label:              best.label,
    minPrice:           best.minPrice,
    maxPrice:           best.maxPrice,
    numGrids:           best.numGrids,
    expectedApy:        best.median,
    p10:                best.p10,
    p25:                best.p25,
    p75:                best.p75,
    p90:                best.p90,
    probAboveTarget:    best.probAboveTarget,
    gridSpacing:        +spacing.toFixed(0),
    gridSpacingPct:     +(spacing / mid * 100).toFixed(2),
    profitPerRoundTrip: best.profitPerRoundTrip,
    avgTradesPerYear:   best.avgTradesPerYear,
    investment:         inv,
    annualProfit:       inv ? Math.round(inv * best.median / 100) : null,
  };
}
