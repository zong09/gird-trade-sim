import express from 'express';
import path    from 'path';
import fs      from 'fs';
import multer  from 'multer';
import { Config, AssetConfig, Asset }                    from './types';
import { loadCandles }                                   from './loader';
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

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, dataDir),
  filename: (req, file, cb) => cb(null, (req.body?.targetFilename as string) || file.originalname),
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.json')) cb(null, true);
    else cb(new Error('Only .json files are allowed'));
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

    const dataFile = path.resolve(__dirname, asset.dataFile);

    // Backtest
    const investment = cfg.simulation.investment ?? DEFAULT_INVESTMENT;
    const btCandles  = loadCandles(dataFile, cfg.backtest.period);
    const gridParams = cfg.backtest.auto
      ? resolveGridParams(btCandles, cfg.backtest.auto, investment, cfg.feeRate)
      : { minPrice: cfg.backtest.minPrice!, maxPrice: cfg.backtest.maxPrice!, numGrids: cfg.backtest.numGrids! };
    const bt = runBacktest(btCandles, { ...gridParams, investment, feeRate: cfg.feeRate });

    // Simulation — auto-generate paramSets from training data
    const sim       = cfg.simulation;
    const simData = loadCandles(dataFile, sim.trainingPeriod ?? {});
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

app.get('/api/files', (_req, res) => {
  const assets = readAssets();
  const files = fs.existsSync(dataDir)
    ? fs.readdirSync(dataDir)
        .filter(f => f.endsWith('.json') && f !== 'asset-config.json')
        .map(name => {
          const stat = fs.statSync(path.join(dataDir, name));
          const asset = assets.find(a => a.dataFile === `./data/${name}`)?.name ?? null;
          return { name, asset, size: stat.size, mtime: stat.mtime.toISOString() };
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  res.json(files);
});

app.post('/api/files/upload', (req, res) => {
  upload.single('file')(req as any, res as any, (err: any) => {
    if (err) { res.status(400).json({ error: err.message }); return; }
    if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
    try {
      const { filename, size } = req.file;
      const assetName = (req.body?.assetName as string | undefined)?.trim();
      if (assetName) {
        const assetCfg = ensureAssetConfig();
        const dataFile = `./data/${filename}`;
        if (!assetCfg.assets.find(a => a.name === assetName)) {
          assetCfg.assets.push({ name: assetName, dataFile });
          fs.writeFileSync(assetCfgPath, JSON.stringify(assetCfg, null, 2));
        }
      }
      res.json({ name: filename, size });
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

app.delete('/api/files/:filename', (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(dataDir, filename);
    if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'File not found' }); return; }
    fs.unlinkSync(filePath);
    const assetCfg = ensureAssetConfig();
    assetCfg.assets = assetCfg.assets.filter(a => a.dataFile !== `./data/${filename}`);
    fs.writeFileSync(assetCfgPath, JSON.stringify(assetCfg, null, 2));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`\n  Grid Trading Dashboard → http://localhost:${PORT}\n`);
});
server.timeout = 10 * 60 * 1000;
