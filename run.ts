import fs   from 'fs';
import path from 'path';
import { Config }                                             from './types';
import { loadCandles }                                        from './loader';
import { runBacktest, resolveGridParams }                     from './engine';
import { runMonteCarlo, getRecommendation, autoGenParamSets } from './simulator';

const cfg             = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) as Config;
const fmt             = (n: number) => n.toLocaleString('th-TH', { maximumFractionDigits: 0 });
const BASE_INVESTMENT = 100_000;

// รัน asset เดียว หรือทั้งหมด: node run.ts [BTC|ETH|...]
const targetName  = process.argv[2]?.toUpperCase();
const assetsToRun = targetName
  ? cfg.assets.filter(a => a.name === targetName)
  : cfg.assets;

if (assetsToRun.length === 0) {
  console.error(`Asset "${targetName}" not found. Available: ${cfg.assets.map(a => a.name).join(', ')}`);
  process.exit(1);
}

for (const asset of assetsToRun) {
  const Q        = asset.name.split('/')[1] ?? 'THB';
  const dataFile = path.resolve(__dirname, asset.dataFile);
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`  Asset: ${asset.name}`);
  console.log('═'.repeat(55));

  // ── Backtest ──────────────────────────────────────────────
  const btCandles  = loadCandles(dataFile, cfg.backtest.period);
  const gridParams = cfg.backtest.auto
    ? resolveGridParams(btCandles, cfg.backtest.auto, BASE_INVESTMENT, cfg.feeRate)
    : { minPrice: cfg.backtest.minPrice!, maxPrice: cfg.backtest.maxPrice!, numGrids: cfg.backtest.numGrids! };

  if (cfg.backtest.auto) {
    const a = cfg.backtest.auto;
    console.log(`\n── Auto Grid  (±${a.widthPct / 2}% จากราคาแรก)`);
    console.log(`  ${fmt(gridParams.minPrice)} – ${fmt(gridParams.maxPrice)} ${Q}  |  ${gridParams.numGrids} grids`);
  }

  const bt = runBacktest(btCandles, { ...gridParams, investment: BASE_INVESTMENT, feeRate: cfg.feeRate });
  console.log(`\n── Backtest  ${cfg.backtest.period.start} → ${cfg.backtest.period.end}`);
  console.log(`  APY     : ${bt.apy}%`);
  console.log(`  Profit  : ${fmt(bt.pnl)} ${Q}  (fees ${fmt(bt.fees)} ${Q})`);
  console.log(`  Trades  : ${bt.trades}`);

  // ── Simulation ────────────────────────────────────────────
  const sim       = cfg.simulation;
  const simData   = loadCandles(dataFile, sim.trainingPeriod ?? {});
  const scenarios = sim.scenarios ?? [{ label: 'Base', annualDrift: 0 }];
  const opts      = { targetApy: sim.targetApy, targetProfit: sim.targetProfit ?? null };

  const scenarioResults = scenarios.map(sc => {
    const paramSets = autoGenParamSets(simData, sim.autoParamSets, sc.annualDrift);
    console.log(`\n── Monte Carlo [${sc.label}]  drift=${sc.annualDrift}%  sims=${sim.numSims}  paramSets=${paramSets.length}`);
    const simResults = runMonteCarlo({
      candles: simData, paramSets,
      investment: BASE_INVESTMENT, feeRate: cfg.feeRate,
      numSims: sim.numSims, hoursAhead: sim.hoursAhead,
      blockSize: sim.blockSize, seed: sim.seed,
      annualDrift: sc.annualDrift,
    });

    console.log('\n  Label              P10    P25  Median    P75    P90  P(≥8%)');
    console.log('  ' + '─'.repeat(65));
    for (const r of simResults) {
      console.log(
        `  ${r.label.padEnd(16)}` +
        `${(r.p10.toFixed(1) + '%').padStart(7)}` +
        `${(r.p25.toFixed(1) + '%').padStart(7)}` +
        `${(r.median.toFixed(1) + '%').padStart(8)}` +
        `${(r.p75.toFixed(1) + '%').padStart(7)}` +
        `${(r.p90.toFixed(1) + '%').padStart(7)}` +
        `${(r.probAboveTarget + '%').padStart(8)}`
      );
    }

    const recs = (['balanced', 'safe', 'aggressive'] as const)
      .map(s => getRecommendation(simResults, { ...opts, strategy: s }));

    console.log('\n── Recommendations');
    if (sim.targetProfit) console.log(`  Target profit : ${fmt(sim.targetProfit)} ${Q}/year\n`);
    for (const r of recs) {
      console.log(`  [${r.strategy.toUpperCase()}]  ${r.label}  APY ${r.expectedApy}%  P10 ${r.p10}%  P(≥${sim.targetApy}%) ${r.probAboveTarget}%`);
      if (r.investment) console.log(`           investment ${fmt(r.investment)} ${Q} → ~${fmt(r.annualProfit!)} ${Q}/year`);
    }
    return { label: sc.label, annualDrift: sc.annualDrift, simulation: simResults, recommendations: recs };
  });

  // Save
  const output = { asset: asset.name, quote: Q, backtest: bt, autoGridParams: gridParams, scenarios: scenarioResults };

  const safeName = asset.name.replace('/', '_').toLowerCase();
  fs.writeFileSync(path.join(__dirname, `output_${safeName}.json`), JSON.stringify(output, null, 2));
  console.log(`\n  Saved → output_${safeName}.json`);
}
