export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface GridParams {
  minPrice: number;
  maxPrice: number;
  numGrids: number;
  investment: number;
  feeRate?: number;
}

export interface WeeklySnapshot {
  date: string;
  gridPct: number;
  bhPct: number;
  price: number;
}

export interface BacktestResult extends GridParams {
  feeRate: number;
  firstPrice: number;
  pnl: number;
  fees: number;
  trades: number;
  volume: number;
  apy: number;
  unrealized: number;
  totalPnl: number;
  totalApy: number;
  spacing: number;
  spacingPct: number;
  profitPerRoundTrip: number;
  snapshots: WeeklySnapshot[];
}

export interface ParamSet {
  label?: string;
  minPrice: number;
  maxPrice: number;
  numGrids: number;
}

export interface SimResult {
  label: string;
  minPrice: number;
  maxPrice: number;
  numGrids: number;
  median: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  totalMedian: number;
  totalP10: number;
  totalP25: number;
  totalP75: number;
  totalP90: number;
  probAboveTarget: number;
  probPositive: number;
  avgTradesPerYear: number;
  profitPerRoundTrip: number;
}

export interface Recommendation {
  strategy: string;
  label: string;
  minPrice: number;
  maxPrice: number;
  numGrids: number;
  expectedApy: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  totalExpectedApy: number;
  totalP10: number;
  totalP25: number;
  totalP75: number;
  totalP90: number;
  probAboveTarget: number;
  gridSpacing: number;
  gridSpacingPct: number;
  profitPerRoundTrip: number;
  avgTradesPerYear: number;
  investment: number | null;
  annualProfit: number | null;
}

export interface AutoGridConfig {
  widthPct: number;             // total range width as % of first price, e.g. 100 = ±50%
  numGridsOptions: number[];    // sweep ทุกตัว เลือก numGrids ที่ APY สูงสุด
  numGrids?: number;            // ถ้าระบุ → ใช้ค่านี้เลย ไม่ sweep
  // roundTo: auto-calculated from price magnitude (no need to set manually)
}

export interface Asset {
  name: string;       // full pair e.g. "BTC/THB", "BTC/USDT"
  dataFile: string;
}

export interface AssetConfig {
  assets: Asset[];
}

export interface AutoParamSets {
  // total range width as % of current price, e.g. [40,60,80,100,140] = ±20%, ±30%, ±40%, ±50%, ±70%
  widthPcts: number[];
  numGridsOptions: number[];
}

export interface Scenario {
  label: string;
  annualDrift: number;   // % เช่น 0 = neutral, 80 = +80%/ปี
}

export interface Config {
  assets: Asset[];
  feeRate: number;
  backtest: {
    period: { start?: string; end?: string };
    auto?: AutoGridConfig;
    minPrice?: number;
    maxPrice?: number;
    numGrids?: number;
  };
  simulation: {
    trainingPeriod?: { start?: string; end?: string };
    targetApy: number;
    targetProfit?: number;
    investment?: number;
    numSims: number;
    hoursAhead: number;
    blockSize: number;
    seed: number;
    autoParamSets: AutoParamSets;
    scenarios: Scenario[];
  };
}
