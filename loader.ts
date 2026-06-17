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

// Read + parse a JSON candle file (for migration/import).
export function parseCandleFile(filePath: string): Candle[] {
  const raw = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  return parseCandleData(raw);
}
