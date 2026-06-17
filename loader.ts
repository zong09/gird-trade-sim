import fs from 'fs';
import path from 'path';
import { Candle } from './types';
import { queryCandles } from './db';

interface Period {
  start?: string;
  end?: string;
}

// Load candles for an asset (by name/symbol) from the SQLite store,
// optionally filtered to a date period (YYYY-MM-DD).
export function loadCandles(symbol: string, period: Period = {}): Candle[] {
  return queryCandles(symbol, period);
}

// Parse raw JSON data into Candle[] — auto-detects 4 legacy input formats.
// Used only when importing/migrating JSON files into the DB.
export function parseCandleData(raw: any): Candle[] {
  let candles: Candle[] = [];

  if (Array.isArray(raw)) {
    const first = raw[0];
    if (first?.raw_points) {
      for (const r of raw)
        for (const p of r.raw_points)
          candles.push({ ts: +p[0], open: +p[1], high: +p[2], low: +p[3], close: +p[4] });
    } else if (first?.aggregated_point) {
      // format: { timestamp: { $numberLong: "..." }, aggregated_point: [ts, open, high, low, close, ...] }
      for (const r of raw) {
        const p = r.aggregated_point;
        candles.push({ ts: +p[0], open: +p[1], high: +p[2], low: +p[3], close: +p[4] });
      }
    } else if (Array.isArray(first)) {
      candles = raw.map((p: number[]) => ({ ts: +p[0], open: +p[1], high: +p[2], low: +p[3], close: +p[4] }));
    } else {
      candles = raw as Candle[];
    }
  }

  candles.sort((a, b) => a.ts - b.ts);
  return candles;
}

// Parse CSV text with a header row into Candle[] — maps columns by header name,
// so it handles Bitkub (timestamp,datetime,open,high,low,close,volume) and any
// CSV exposing a time column + open/high/low/close.
export function parseCsvData(text: string): Candle[] {
  const lines = text.split('\n').filter(l => l.trim() !== '');
  if (!lines.length) return [];

  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const find = (...names: string[]) => {
    for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; }
    return -1;
  };
  const tsIdx = find('timestamp', 'ts', 'time', 'date', 'opentime');
  const oIdx  = find('open');
  const hIdx  = find('high');
  const lIdx  = find('low');
  const cIdx  = find('close');

  const missing = [['time', tsIdx], ['open', oIdx], ['high', hIdx], ['low', lIdx], ['close', cIdx]]
    .filter(([, i]) => (i as number) < 0).map(([n]) => n);
  if (missing.length) throw new Error(`CSV missing required columns: ${missing.join(', ')}`);

  // Bitkub/Binance use seconds; normalize ms/μs just in case.
  const normTs = (n: number) => n > 1e15 ? Math.floor(n / 1e6) : n > 1e12 ? Math.floor(n / 1e3) : Math.floor(n);

  const candles: Candle[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const ts = Number(c[tsIdx]);
    if (!Number.isFinite(ts)) continue;   // skip non-data rows
    candles.push({ ts: normTs(ts), open: +c[oIdx], high: +c[hIdx], low: +c[lIdx], close: +c[cIdx] });
  }
  candles.sort((a, b) => a.ts - b.ts);
  return candles;
}

// Validate parsed candles before importing. Returns an error message, or null if valid.
export function validateCandles(candles: Candle[]): string | null {
  if (!candles.length) return 'No candles found — file is empty or not a recognized OHLC format';
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (![c.ts, c.open, c.high, c.low, c.close].every(Number.isFinite))
      return `Row ${i}: ts/open/high/low/close must all be finite numbers`;
    if (c.ts <= 0) return `Row ${i}: invalid timestamp (${c.ts})`;
    if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0)
      return `Row ${i}: prices must be positive`;
    if (c.high < c.low) return `Row ${i}: high (${c.high}) < low (${c.low})`;
  }
  return null;
}

// Read + parse a JSON candle file (for migration/import).
export function parseCandleFile(filePath: string): Candle[] {
  const raw = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  return parseCandleData(raw);
}
