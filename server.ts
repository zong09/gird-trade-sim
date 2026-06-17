import express from 'express';
import path    from 'path';
import fs      from 'fs';
import multer  from 'multer';
import { Config, AssetConfig, Asset }                    from './types';
import { loadCandles, parseCandleData, parseCsvData, validateCandles } from './loader';
import { listSymbols, insertCandles, deleteSymbol }      from './db';
import { searchSymbols, syncKlines }                     from './binance';
import { runBacktest, resolveGridParams }                from './engine';
import { runMonteCarlo, getRecommendation, autoGenParamSets } from './simulator';

const app             = express();
const PORT            = 3000;
const cfgPath         = path.join(__dirname, 'config.json');
const assetCfgPath    = path.join(__dirname, 'data', 'asset-config.json');
const DEFAULT_INVESTMENT = 100_000;

function ensureAssetConfig(): AssetConfig {
  if (!fs.existsSync(assetCfgPath)) {
    const empty: AssetConfig = { assets: [] };
    fs.mkdirSync(path.dirname(assetCfgPath), { recursive: true });
    fs.writeFileSync(assetCfgPath, JSON.stringify(empty, null, 2));
    return empty;
  }
  return JSON.parse(fs.readFileSync(assetCfgPath, 'utf8')) as AssetConfig;
}

function readAssets(): Asset[] {
  try { return ensureAssetConfig().assets; } catch { return []; }
}

function readConfig(): Config {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Omit<Config, 'assets'>;
  return { ...cfg, assets: readAssets() };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const n = file.originalname.toLowerCase();
    if (n.endsWith('.json') || n.endsWith('.csv')) cb(null, true);
    else cb(new Error('Only .json or .csv files are allowed'));
  },
});

const pkgVersion: string = (() => {
  try { return (JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as any).version ?? '—'; }
  catch { return '—'; }
})();

app.get('/api/config', (_req, res) => {
  res.json({ ...readConfig(), version: pkgVersion });
});

// POST /api/run  body: { asset: "BTC", config?: Config }
// config overrides come from the UI form for this run only — never persisted
app.post('/api/run', async (req, res) => {
  try {
    const cfg = (req.body?.config as Config | undefined)
      ?? readConfig();
    const assetName = (req.body?.asset as string) || cfg.assets[0].name;
    const asset     = cfg.assets.find(a => a.name === assetName);
    if (!asset) return res.status(400).json({ error: `Asset "${assetName}" not found` });

    // Backtest
    const investment = cfg.simulation.investment ?? DEFAULT_INVESTMENT;
    const btCandles  = loadCandles(assetName, cfg.backtest.period);
    const gridParams = cfg.backtest.auto
      ? resolveGridParams(btCandles, cfg.backtest.auto, investment, cfg.feeRate)
      : { minPrice: cfg.backtest.minPrice!, maxPrice: cfg.backtest.maxPrice!, numGrids: cfg.backtest.numGrids! };
    const bt = runBacktest(btCandles, { ...gridParams, investment, feeRate: cfg.feeRate });

    // Simulation — auto-generate paramSets from training data
    const sim       = cfg.simulation;
    const simData = loadCandles(assetName, sim.trainingPeriod ?? {});
    const opts    = { targetApy: sim.targetApy, targetProfit: sim.targetProfit ?? null };
    const scenarios = (sim.scenarios ?? [{ label: 'Base', annualDrift: 0 }]);

    const scenarioResults = scenarios.map(sc => {
      const paramSets  = autoGenParamSets(simData, sim.autoParamSets, sc.annualDrift);
      const simResults = runMonteCarlo({
        candles: simData, paramSets,
        investment, feeRate: cfg.feeRate,
        numSims: sim.numSims, hoursAhead: sim.hoursAhead,
        blockSize: sim.blockSize, seed: sim.seed,
        annualDrift: sc.annualDrift,
      });
      const recs = (['balanced', 'safe', 'aggressive'] as const)
        .map(s => getRecommendation(simResults, { ...opts, strategy: s }));
      return { label: sc.label, annualDrift: sc.annualDrift, simulation: simResults, recommendations: recs };
    });

    const quote    = assetName.split('/')[1] ?? 'THB';
    const refPrice = simData.length > 0 ? simData[simData.length - 1].close : null;
    const output = { asset: assetName, quote, backtest: bt, autoGridParams: gridParams, scenarios: scenarioResults, refPrice, investment };
    res.json(output);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/output/:asset', (req, res) => {
  const p = path.join(__dirname, `output_${req.params.asset.replace('/', '_').toLowerCase()}.json`);
  res.json(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
});

// List assets (from SQLite) with row counts + date range, in asset-config order.
app.get('/api/files', (_req, res) => {
  const stats = new Map(listSymbols().map(s => [s.symbol, s]));
  const order = readAssets().map(a => a.name);
  const names = [...new Set([...order, ...stats.keys()])];
  const files = names.map(name => {
    const s = stats.get(name);
    return {
      name,
      rows:  s?.rows ?? 0,
      first: s ? new Date(s.first * 1000).toISOString().slice(0, 10) : null,
      last:  s ? new Date(s.last  * 1000).toISOString().slice(0, 10) : null,
    };
  });
  res.json(files);
});

// Upload a JSON candle file → parse → import into SQLite under assetName.
app.post('/api/files/upload', (req, res) => {
  upload.single('file')(req as any, res as any, (err: any) => {
    if (err) { res.status(400).json({ error: err.message }); return; }
    if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
    try {
      const assetName = (req.body?.assetName as string | undefined)?.trim();
      if (!assetName) { res.status(400).json({ error: 'assetName is required' }); return; }
      const text = req.file.buffer.toString('utf8');
      let candles;
      if (req.file.originalname.toLowerCase().endsWith('.csv')) {
        candles = parseCsvData(text);   // throws on missing required columns
      } else {
        let raw: any;
        try { raw = JSON.parse(text); }
        catch { res.status(400).json({ error: 'File is not valid JSON' }); return; }
        candles = parseCandleData(raw);
      }
      const invalid = validateCandles(candles);
      if (invalid) { res.status(400).json({ error: invalid }); return; }
      const rows = insertCandles(assetName, candles);
      const assetCfg = ensureAssetConfig();
      if (!assetCfg.assets.find(a => a.name === assetName)) {
        assetCfg.assets.push({ name: assetName });
        fs.writeFileSync(assetCfgPath, JSON.stringify(assetCfg, null, 2));
      }
      res.json({ name: assetName, rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
});

// POST /api/files/reorder  body: { names: ["BTC/THB", "ETH/THB", ...] }
app.post('/api/files/reorder', (req, res) => {
  try {
    const names = req.body?.names as string[];
    if (!Array.isArray(names)) { res.status(400).json({ error: 'names must be an array' }); return; }
    const assetCfg = ensureAssetConfig();
    const map = new Map(assetCfg.assets.map(a => [a.name, a]));
    assetCfg.assets = names.map(n => map.get(n)).filter(Boolean) as Asset[];
    fs.writeFileSync(assetCfgPath, JSON.stringify(assetCfg, null, 2));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Delete an asset: drop its candles from SQLite + remove from asset-config.
app.delete('/api/files/:name', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    deleteSymbol(name);
    const assetCfg = ensureAssetConfig();
    assetCfg.assets = assetCfg.assets.filter(a => a.name !== name);
    fs.writeFileSync(assetCfgPath, JSON.stringify(assetCfg, null, 2));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Search Binance trading pairs (cached exchangeInfo).
app.get('/api/binance/symbols', async (req, res) => {
  try {
    res.json(await searchSymbols((req.query.q as string) || ''));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Sync klines from data.binance.vision into SQLite, streaming progress via SSE.
app.get('/api/binance/sync', async (req, res) => {
  const { symbol, interval, start, end, name } = req.query as Record<string, string>;
  if (!symbol || !interval || !start || !end || !name) {
    res.status(400).json({ error: 'symbol, interval, start, end, name are required' });
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (event: string, data: any) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const result = await syncKlines({ symbol, interval, start, end, name }, p => send('progress', p));
    send('done', result);
  } catch (e: any) {
    send('error', { message: e.message });
  }
  res.end();
});

const server = app.listen(PORT, () => {
  console.log(`\n  Grid Trading Dashboard → http://localhost:${PORT}\n`);
});
server.timeout = 10 * 60 * 1000;
