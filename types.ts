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
  slippage?: number;   // per-side execution slippage, e.g. 0.0005 = 0.05%
  skipSnapshots?: boolean;   // skip daily snapshot building — used by Monte Carlo where snapshots are discarded
}

export type BacktestModel = 'crossing' | 'external';

export interface WeeklySnapshot {
  date: string;
  gridPct: number;
  bhPct: number;
  price: number;
}

export interface BacktestResult extends GridParams {
  model: BacktestModel;   // which fill model produced this result
  feeRate: number;
  firstPrice: number;
  firstMatchPrice: number;   // grid line price of the first executed trade
  pnl: number;
  fees: number;
  trades: number;
  volume: number;
  buyVolume?: number;    // gross buy notional (Σ qty·buyPrice)
  sellVolume?: number;   // gross sell notional (Σ qty·sellPrice)
  apy: number;
  unrealized: number;
  totalPnl: number;
  totalApy: number;
  totalReturnPct: number;   // totalPnl as % of capital (not annualized)
  spacing: number;
  spacingPct: number;
  profitPerRoundTrip: number;
  snapshots: WeeklySnapshot[];
}

// Summary row for a saved backtest run — every column except the result_json blob.
export interface BacktestRunSummary {
  id: number;
  created_at: number;   // epoch seconds
  label: string | null;
  symbol: string;
  start: string;
  end: string;
  width_pct: number | null;
  num_grids: number;
  investment: number;
  fee_rate: number;
  slippage: number | null;
  realized_apy: number;
  total_apy: number;
  pnl: number;
  total_pnl: number;
  trades: number;
}

// A saved run loaded back in full, including the BacktestResult parsed from result_json.
export interface SavedBacktestRun extends BacktestRunSummary {
  result: BacktestResult;
}

// Payload accepted by saveBacktestRun / POST /api/runs.
export interface SaveBacktestRunInput {
  label?: string | null;
  symbol: string;
  start: string;
  end: string;
  widthPct?: number | null;
  numGrids: number;
  investment: number;
  feeRate: number;
  slippage?: number | null;
  result: BacktestResult;
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
  widthPct: number;             // total range width as % of first price, e.g. 100 = ±50% (fallback when downPct/upPct absent)
  downPct?: number;             // downward range as % below first price (positive, e.g. 50 = -50%); falls back to widthPct/2
  upPct?: number;               // upward range as % above first price (e.g. 100 = +100%); falls back to widthPct/2
  numGridsOptions: number[];    // sweep ทุกตัว เลือก numGrids ที่ APY สูงสุด
  numGrids?: number;            // ถ้าระบุ → ใช้ค่านี้เลย ไม่ sweep
  // roundTo: auto-calculated from price magnitude (no need to set manually)
}

export interface Asset {
  name: string;       // full pair e.g. "BTC/THB", "BTC/USDT"
  dataFile?: string;  // legacy JSON path (optional); candles now live in SQLite by name
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
  slippage?: number;   // per-side execution slippage, e.g. 0.0005 = 0.05%
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
