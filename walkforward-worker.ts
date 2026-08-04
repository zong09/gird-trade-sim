import { parentPort } from 'worker_threads';
import { WalkForwardPeriod, WalkForwardTask, WalkForwardTaskResult } from './types';
import { loadCandles } from './loader';
import { runBacktest, resolveGridParams } from './engine';

function runTask(task: WalkForwardTask): WalkForwardTaskResult {
  try {
    const { assetName, start, end, cfg, investment, targetApy, targetProfit } = task;
    const candles = loadCandles(assetName, { start, end });
    const gridParams = cfg.backtest.auto
      ? resolveGridParams(candles, cfg.backtest.auto, investment, cfg.feeRate, cfg.slippage)
      : { minPrice: cfg.backtest.minPrice!, maxPrice: cfg.backtest.maxPrice!, numGrids: cfg.backtest.numGrids! };
    const bt = runBacktest(candles, { ...gridParams, investment, feeRate: cfg.feeRate, slippage: cfg.slippage });

    const meetsApy    = targetApy    != null ? bt.apy >= targetApy               : null;
    const meetsProfit = targetProfit != null ? bt.totalReturnPct >= targetProfit : null;
    const meetsTarget = (meetsApy ?? true) && (meetsProfit ?? true);

    const period: WalkForwardPeriod = {
      start, end,
      minPrice: gridParams.minPrice, maxPrice: gridParams.maxPrice, numGrids: gridParams.numGrids,
      apy: bt.apy, totalApy: bt.totalApy, pnl: bt.pnl, totalPnl: bt.totalPnl, totalReturnPct: bt.totalReturnPct, trades: bt.trades,
      capitalTurnover: bt.volume / investment,
      meetsApy, meetsProfit, meetsTarget,
    };
    return { index: task.index, period };
  } catch (e: any) {
    return { index: task.index, error: e.message };
  }
}

parentPort?.on('message', (task: WalkForwardTask) => {
  parentPort!.postMessage(runTask(task));
});
