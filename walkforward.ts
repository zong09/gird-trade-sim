import os from 'os';
import path from 'path';
import { Worker } from 'worker_threads';
import { Config, WalkForwardPeriod, WalkForwardResult, WalkForwardTask, WalkForwardTaskResult } from './types';
import { listSymbols } from './db';

// Matches server.ts's DEFAULT_INVESTMENT — used when simulation.investment is unset.
const DEFAULT_INVESTMENT = 100_000;

function toIsoDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function addMonthsUTC(isoDate: string, months: number): Date {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + months, d));
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Generate overlapping windowMonths-long periods, sliding forward 1 month at a time,
// starting at firstDate and stopping once a window's end would exceed lastDate.
// End is inclusive of the whole day (matches queryCandles' end-inclusive semantics),
// e.g. windowMonths=12 from "2023-06-01" → "2023-06-01".."2024-05-31".
export function generateWindows(firstTs: number, lastTs: number, windowMonths: number): { start: string; end: string }[] {
  const firstDate = toIsoDate(firstTs);
  const lastDate  = toIsoDate(lastTs);
  const windows: { start: string; end: string }[] = [];
  for (let i = 0; ; i++) {
    const start = toIso(addMonthsUTC(firstDate, i));
    const endExclusive = addMonthsUTC(start, windowMonths);
    const end = toIso(new Date(endExclusive.getTime() - 86400_000));
    if (end > lastDate) break;
    windows.push({ start, end });
  }
  return windows;
}

export async function runWalkForward(
  cfg: Config,
  assetName: string,
  windowMonths: number,
  options: { targetApy?: number; targetProfit?: number; startDate?: string },
  onProgress?: (done: number, total: number) => void,
): Promise<WalkForwardResult> {
  const info = listSymbols().find(s => s.symbol === assetName);
  if (!info || info.rows === 0) throw new Error(`No candle data for asset "${assetName}"`);

  // Clamp to the asset's real first candle — an earlier override would generate
  // windows with no candles at all, which crashes on candles[0].open downstream.
  let startTs = info.first;
  if (options.startDate) {
    const overrideTs = Math.floor(Date.parse(options.startDate) / 1000);
    if (!Number.isNaN(overrideTs)) startTs = Math.max(startTs, overrideTs);
  }

  const windows = generateWindows(startTs, info.last, windowMonths);
  if (windows.length === 0) throw new Error(`Not enough history for a ${windowMonths}-month window`);

  const investment = cfg.simulation.investment ?? DEFAULT_INVESTMENT;
  const { targetApy, targetProfit } = options;

  // Each window is an independent, CPU-bound backtest — run them on a pool of
  // worker_threads sized to all cores. The main thread's own work during a run
  // (dispatching tasks, writing small SSE messages) is too light to need a
  // reserved core — reserving one instead just leaves it idle. Never spawn more
  // workers than windows.
  const cfgSlice = { backtest: cfg.backtest, feeRate: cfg.feeRate, slippage: cfg.slippage };
  const poolSize = Math.max(1, Math.min(os.cpus().length, windows.length));
  const workers = Array.from({ length: poolSize }, () =>
    new Worker(path.join(__dirname, 'walkforward-worker.ts'), { execArgv: ['-r', 'ts-node/register'] }));

  const periods: WalkForwardPeriod[] = new Array(windows.length);
  let nextIndex = 0;
  let doneCount = 0;

  function nextTask(): WalkForwardTask | null {
    if (nextIndex >= windows.length) return null;
    const i = nextIndex++;
    const { start, end } = windows[i];
    return { index: i, assetName, start, end, cfg: cfgSlice, investment, targetApy, targetProfit };
  }

  try {
    await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', (result: WalkForwardTaskResult) => {
        if (result.error) { reject(new Error(result.error)); return; }
        periods[result.index] = result.period!;
        doneCount++;
        onProgress?.(doneCount, windows.length);
        const task = nextTask();
        if (task) worker.postMessage(task);
        else resolve();
      });
      const task = nextTask();
      if (task) worker.postMessage(task);
      else resolve();
    })));
  } finally {
    await Promise.all(workers.map(w => w.terminate()));
  }

  const periodsMet = periods.filter(p => p.meetsTarget).length;
  const avgApy      = periods.reduce((s, p) => s + p.apy, 0) / periods.length;
  const avgTotalApy = periods.reduce((s, p) => s + p.totalApy, 0) / periods.length;
  const sortedByApy = [...periods].sort((a, b) => b.apy - a.apy);

  return {
    asset: assetName,
    windowMonths,
    targetApy: targetApy ?? null,
    targetProfit: targetProfit ?? null,
    windows: periods,
    summary: {
      totalPeriods: periods.length,
      periodsMet,
      passRate: (periodsMet / periods.length) * 100,
      avgApy,
      avgTotalApy,
      bestPeriod: sortedByApy[0],
      worstPeriod: sortedByApy[sortedByApy.length - 1],
    },
  };
}
