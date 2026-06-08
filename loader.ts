import fs from 'fs';
import path from 'path';
import { Candle } from './types';

interface Period {
  start?: string;
  end?: string;
}

export function loadCandles(filePath: string, period: Period = {}): Candle[] {
  const raw = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));

  let candles: Candle[] = [];

  if (Array.isArray(raw)) {
    const first = raw[0];
    if (first?.raw_points) {
      for (const r of raw)
        for (const p of r.raw_points)
          candles.push({ ts: +p[0], open: +p[1], high: +p[2], low: +p[3], close: +p[4] });
    } else if (Array.isArray(first)) {
      candles = raw.map((p: number[]) => ({ ts: +p[0], open: +p[1], high: +p[2], low: +p[3], close: +p[4] }));
    } else {
      candles = raw as Candle[];
    }
  }

  candles.sort((a, b) => a.ts - b.ts);

  const startTs = period.start ? Date.parse(period.start) / 1000 : 0;
  const endTs   = period.end   ? Date.parse(period.end)   / 1000 + 86400 : Infinity;

  return candles.filter(c => c.ts >= startTs && c.ts <= endTs);
}
