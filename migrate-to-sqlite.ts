import fs   from 'fs';
import path from 'path';
import { AssetConfig } from './types';
import { parseCandleFile } from './loader';
import { insertCandles, listSymbols } from './db';

// One-time: import existing JSON-file assets into the SQLite store.
const assetCfgPath = path.join(__dirname, 'data', 'asset-config.json');

if (!fs.existsSync(assetCfgPath)) {
  console.error('No data/asset-config.json found — nothing to migrate.');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(assetCfgPath, 'utf8')) as AssetConfig;

for (const asset of cfg.assets) {
  if (!asset.dataFile) { console.log(`skip "${asset.name}" (no dataFile)`); continue; }
  const filePath = path.resolve(__dirname, asset.dataFile);
  if (!fs.existsSync(filePath)) { console.warn(`skip "${asset.name}" — file missing: ${asset.dataFile}`); continue; }
  try {
    const candles = parseCandleFile(filePath);
    const added   = insertCandles(asset.name, candles);
    console.log(`"${asset.name}"  +${added} rows  (from ${asset.dataFile})`);
  } catch (e: any) {
    console.warn(`failed "${asset.name}": ${e.message}`);
  }
}

console.log('\nDB symbols now:');
for (const s of listSymbols()) {
  console.log(`  ${s.symbol.padEnd(20)} ${s.rows} rows  ${new Date(s.first * 1000).toISOString().slice(0, 10)} → ${new Date(s.last * 1000).toISOString().slice(0, 10)}`);
}
