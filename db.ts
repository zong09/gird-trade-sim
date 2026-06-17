import Database from 'better-sqlite3';
import path from 'path';
import fs   from 'fs';
import { Candle } from './types';

interface Period {
  start?: string;
  end?: string;
}

export interface SymbolInfo {
  symbol: string;
  rows: number;
  first: number;   // ts seconds
  last: number;
}

const dbPath = path.join(__dirname, 'data', 'candles.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS candles (
      symbol TEXT    NOT NULL,
      ts     INTEGER NOT NULL,
      open   REAL,
      high   REAL,
      low    REAL,
      close  REAL,
      PRIMARY KEY (symbol, ts)
    );
  `);
  _db = db;
  return db;
}

// Insert candles for a symbol; INSERT OR IGNORE dedups by (symbol, ts).
// Returns number of rows actually inserted.
export function insertCandles(symbol: string, candles: Candle[]): number {
  const db   = getDb();
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO candles (symbol, ts, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const before = countRows(symbol);
  const tx = db.transaction((rows: Candle[]) => {
    for (const c of rows) stmt.run(symbol, c.ts, c.open, c.high, c.low, c.close);
  });
  tx(candles);
  return countRows(symbol) - before;
}

function countRows(symbol: string): number {
  const row = getDb().prepare('SELECT COUNT(*) n FROM candles WHERE symbol = ?').get(symbol) as { n: number };
  return row.n;
}

// Query candles for a symbol within an optional date period (YYYY-MM-DD).
export function queryCandles(symbol: string, period: Period = {}): Candle[] {
  const startTs = period.start ? Date.parse(period.start) / 1000 : 0;
  const endTs   = period.end   ? Date.parse(period.end)   / 1000 + 86400 : Number.MAX_SAFE_INTEGER;
  return getDb()
    .prepare('SELECT ts, open, high, low, close FROM candles WHERE symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts')
    .all(symbol, startTs, endTs) as Candle[];
}

export function listSymbols(): SymbolInfo[] {
  return getDb()
    .prepare('SELECT symbol, COUNT(*) rows, MIN(ts) first, MAX(ts) last FROM candles GROUP BY symbol ORDER BY symbol')
    .all() as SymbolInfo[];
}

export function deleteSymbol(symbol: string): void {
  getDb().prepare('DELETE FROM candles WHERE symbol = ?').run(symbol);
}
