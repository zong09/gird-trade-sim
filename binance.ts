import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { Candle, AssetConfig } from './types';
import { insertCandles } from './db';

const cacheDir      = path.join(__dirname, 'data', 'binance');
const assetCfgPath  = path.join(__dirname, 'data', 'asset-config.json');
const VISION_BASE   = 'https://data.binance.vision/data/spot/monthly/klines';
const EXCHANGE_INFO = 'https://api.binance.com/api/v3/exchangeInfo';

// ── Symbol search (cached exchangeInfo) ──────────────────────────────
export interface BinanceSymbol { symbol: string; base: string; quote: string; }

let _symCache: { ts: number; data: BinanceSymbol[] } | null = null;
const CACHE_TTL = 6 * 3600 * 1000;   // 6h

async function getAllSymbols(): Promise<BinanceSymbol[]> {
  const now = Date.now();
  if (_symCache && now - _symCache.ts < CACHE_TTL) return _symCache.data;
  const res = await fetch(EXCHANGE_INFO);
  if (!res.ok) throw new Error(`exchangeInfo HTTP ${res.status}`);
  const json = await res.json() as { symbols: { symbol: string; baseAsset: string; quoteAsset: string; status: string }[] };
  const data = json.symbols
    .filter(s => s.status === 'TRADING')
    .map(s => ({ symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset }));
  _symCache = { ts: now, data };
  return data;
}

export async function searchSymbols(query: string, limit = 50): Promise<BinanceSymbol[]> {
  const all = await getAllSymbols();
  const q   = (query || '').toUpperCase().trim();
  if (!q) return all.slice(0, limit);
  const exact   = all.filter(s => s.symbol === q || s.base === q);
  const partial = all.filter(s => s.symbol.includes(q) && !exact.includes(s));
  return [...exact, ...partial].slice(0, limit);
}

// ── Kline sync from data.binance.vision ──────────────────────────────
export interface SyncProgress {
  month: string;
  status: 'downloaded' | 'cached' | 'skipped';
  rows: number;
}

export interface SyncArgs {
  symbol: string;     // Binance symbol e.g. BTCUSDT
  interval: string;   // e.g. 1m
  start: string;      // YYYY-MM
  end: string;        // YYYY-MM
  name: string;       // asset name / DB symbol e.g. "BTC/USDT 1m"
}

function monthRange(start: string, end: string): string[] {
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  const months: string[] = [];
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return months;
}

// Binance kline timestamps switched to microseconds (~2025); older are ms.
function normalizeTs(raw: number): number {
  if (raw > 1e15) return Math.floor(raw / 1e6);   // μs
  if (raw > 1e12) return Math.floor(raw / 1e3);    // ms
  return Math.floor(raw);                          // s
}

function parseCsv(text: string): Candle[] {
  const out: Candle[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const c = line.split(',');
    const t = Number(c[0]);
    if (!Number.isFinite(t)) continue;   // skip header / blank
    out.push({ ts: normalizeTs(t), open: +c[1], high: +c[2], low: +c[3], close: +c[4] });
  }
  return out;
}

// One-time: move legacy flat cache files (data/binance/SYM-INT-YYYY-MM.csv)
// into their {SYMBOL}/{INTERVAL}/ subfolder. Idempotent — safe to call each sync.
function migrateFlatCache(): void {
  if (!fs.existsSync(cacheDir)) return;
  for (const file of fs.readdirSync(cacheDir)) {
    if (!file.endsWith('.csv')) continue;
    const parts = file.slice(0, -4).split('-');   // SYMBOL-INTERVAL-YYYY-MM
    if (parts.length !== 4) continue;              // unrecognized name → leave
    const [symbol, interval] = parts;
    const dir = path.join(cacheDir, symbol, interval);
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(path.join(cacheDir, file), path.join(dir, file));
  }
}

// Download+extract one month's CSV into data/binance/{SYMBOL}/{INTERVAL}/,
// return its path (or null on 404).
function ensureMonthCsv(symbol: string, interval: string, month: string): { path: string; downloaded: boolean } | null {
  const dir = path.join(cacheDir, symbol, interval);
  fs.mkdirSync(dir, { recursive: true });
  const base    = `${symbol}-${interval}-${month}`;
  const csvPath = path.join(dir, `${base}.csv`);
  if (fs.existsSync(csvPath)) return { path: csvPath, downloaded: false };

  const url     = `${VISION_BASE}/${symbol}/${interval}/${base}.zip`;
  const zipPath = path.join(dir, `${base}.zip`);
  try {
    execFileSync('curl', ['-fsSL', '-o', zipPath, url], { stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('unzip', ['-o', zipPath, '-d', dir], { stdio: ['ignore', 'ignore', 'ignore'] });
    return { path: csvPath, downloaded: true };
  } catch {
    return null;   // 404 / not available
  } finally {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  }
}

function registerAsset(name: string): void {
  let cfg: AssetConfig = { assets: [] };
  if (fs.existsSync(assetCfgPath)) cfg = JSON.parse(fs.readFileSync(assetCfgPath, 'utf8')) as AssetConfig;
  if (!cfg.assets.find(a => a.name === name)) {
    cfg.assets.push({ name });
    fs.mkdirSync(path.dirname(assetCfgPath), { recursive: true });
    fs.writeFileSync(assetCfgPath, JSON.stringify(cfg, null, 2));
  }
}

export async function syncKlines(
  { symbol, interval, start, end, name }: SyncArgs,
  onProgress?: (p: SyncProgress) => void,
): Promise<{ rowsAdded: number; months: number }> {
  migrateFlatCache();
  const months = monthRange(start, end);
  let rowsAdded = 0;
  let synced = 0;

  for (const month of months) {
    const got = ensureMonthCsv(symbol, interval, month);
    if (!got) {
      onProgress?.({ month, status: 'skipped', rows: 0 });
    } else {
      const candles = parseCsv(fs.readFileSync(got.path, 'utf8'));
      const added   = insertCandles(name, candles);
      rowsAdded += added;
      synced++;
      onProgress?.({ month, status: got.downloaded ? 'downloaded' : 'cached', rows: added });
    }
    // yield to event loop so SSE progress flushes to the client
    await new Promise(r => setImmediate(r));
  }

  if (synced > 0) registerAsset(name);
  return { rowsAdded, months: months.length };
}
