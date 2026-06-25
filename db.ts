import Database from 'better-sqlite3';
import path from 'path';
import fs   from 'fs';
import { Candle, BacktestRunSummary, SavedBacktestRun, SaveBacktestRunInput } from './types';

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
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  INTEGER NOT NULL,
      label       TEXT,
      symbol      TEXT    NOT NULL,
      start       TEXT    NOT NULL,
      end         TEXT    NOT NULL,
      width_pct   REAL,
      num_grids   INTEGER NOT NULL,
      investment  REAL    NOT NULL,
      fee_rate    REAL    NOT NULL,
      slippage    REAL,
      realized_apy REAL,
      total_apy    REAL,
      pnl          REAL,
      total_pnl    REAL,
      trades       INTEGER,
      result_json  TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_created ON backtest_runs(created_at);
    -- Maintained row-count cache per symbol. A full COUNT(*) GROUP BY over the
    -- candles table scans every row (seconds on large DBs); this table lets
    -- listSymbols return instantly. Kept in sync by insertCandles/deleteSymbol.
    CREATE TABLE IF NOT EXISTS candle_stats (
      symbol TEXT PRIMARY KEY,
      rows   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  _db = db;
  return db;
}

// Insert candles for a symbol; INSERT OR IGNORE dedups by (symbol, ts).
// Returns number of rows actually inserted.
export function insertCandles(symbol: string, candles: Candle[]): number {
  const db   = getDb();
  ensureStats(symbol);
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO candles (symbol, ts, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?)'
  );
  let inserted = 0;
  const tx = db.transaction((rows: Candle[]) => {
    // INSERT OR IGNORE reports changes=1 only when a new row is actually added.
    for (const c of rows) inserted += stmt.run(symbol, c.ts, c.open, c.high, c.low, c.close).changes;
  });
  tx(candles);
  db.prepare('UPDATE candle_stats SET rows = rows + ? WHERE symbol = ?').run(inserted, symbol);
  return inserted;
}

// Make sure candle_stats holds a correct row count for symbol. Seeds the row
// (one COUNT(*) for legacy symbols, 0 for new ones) so increments can apply.
function ensureStats(symbol: string): void {
  const db = getDb();
  if (db.prepare('SELECT 1 FROM candle_stats WHERE symbol = ?').get(symbol)) return;
  const n = (db.prepare('SELECT COUNT(*) n FROM candles WHERE symbol = ?').get(symbol) as { n: number }).n;
  db.prepare('INSERT INTO candle_stats (symbol, rows) VALUES (?, ?)').run(symbol, n);
}

// Query candles for a symbol within an optional date period (YYYY-MM-DD).
export function queryCandles(symbol: string, period: Period = {}): Candle[] {
  const startTs = period.start ? Date.parse(period.start) / 1000 : 0;
  // end is inclusive of the whole end day: include candles with ts < (end + 1 day),
  // i.e. exclusive upper bound — matches grid_engine.py's `index < end + Timedelta(days=1)`.
  const endTs   = period.end   ? Date.parse(period.end)   / 1000 + 86400 : Number.MAX_SAFE_INTEGER;
  return getDb()
    .prepare('SELECT ts, open, high, low, close FROM candles WHERE symbol = ? AND ts >= ? AND ts < ? ORDER BY ts')
    .all(symbol, startTs, endTs) as Candle[];
}

export function listSymbols(): SymbolInfo[] {
  const db = getDb();
  backfillStatsOnce();
  // rows come from the maintained cache; first/last are single index seeks
  // (PK is (symbol, ts)), each O(log n) — vs MIN/MAX GROUP BY which scans all rows.
  const first = db.prepare('SELECT ts FROM candles WHERE symbol = ? ORDER BY ts ASC  LIMIT 1');
  const last  = db.prepare('SELECT ts FROM candles WHERE symbol = ? ORDER BY ts DESC LIMIT 1');
  return (db.prepare('SELECT symbol, rows FROM candle_stats ORDER BY symbol').all() as { symbol: string; rows: number }[])
    .map(s => ({
      symbol: s.symbol,
      rows:   s.rows,
      first:  (first.get(s.symbol) as { ts: number } | undefined)?.ts ?? 0,
      last:   (last.get(s.symbol)  as { ts: number } | undefined)?.ts ?? 0,
    }));
}

// One-time population of candle_stats from the existing candles table, for DBs
// created before the cache existed. Guarded by a meta flag so the full
// COUNT(*) GROUP BY scan runs at most once per DB; afterwards the cache is kept
// current incrementally by insertCandles/deleteSymbol.
function backfillStatsOnce(): void {
  const db = getDb();
  if (db.prepare("SELECT 1 FROM meta WHERE key = 'stats_backfilled'").get()) return;
  const counts = db.prepare('SELECT symbol, COUNT(*) rows FROM candles GROUP BY symbol').all() as { symbol: string; rows: number }[];
  const ins = db.prepare('INSERT OR REPLACE INTO candle_stats (symbol, rows) VALUES (?, ?)');
  db.transaction(() => {
    for (const c of counts) ins.run(c.symbol, c.rows);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('stats_backfilled', '1')").run();
  })();
}

export function deleteSymbol(symbol: string): void {
  const db = getDb();
  db.prepare('DELETE FROM candles WHERE symbol = ?').run(symbol);
  db.prepare('DELETE FROM candle_stats WHERE symbol = ?').run(symbol);
}

// Persist a backtest run. Summary columns are derived from the result; the full
// BacktestResult (including daily snapshots) is stored as the result_json blob.
// Returns the new row id.
export function saveBacktestRun(input: SaveBacktestRunInput): number {
  const r = input.result;
  const info = getDb().prepare(`
    INSERT INTO backtest_runs
      (created_at, label, symbol, start, end, width_pct, num_grids, investment,
       fee_rate, slippage, realized_apy, total_apy, pnl, total_pnl, trades, result_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Math.floor(Date.now() / 1000),
    input.label ?? null,
    input.symbol,
    input.start,
    input.end,
    input.widthPct ?? null,
    input.numGrids,
    input.investment,
    input.feeRate,
    input.slippage ?? null,
    r.apy,
    r.totalApy,
    r.pnl,
    r.totalPnl,
    r.trades,
    JSON.stringify(r),
  );
  return Number(info.lastInsertRowid);
}

// List saved runs newest-first, without the heavy result_json blob.
export function listBacktestRuns(): BacktestRunSummary[] {
  return getDb()
    .prepare(`
      SELECT id, created_at, label, symbol, start, end, width_pct, num_grids,
             investment, fee_rate, slippage, realized_apy, total_apy, pnl, total_pnl, trades
      FROM backtest_runs ORDER BY created_at DESC, id DESC
    `)
    .all() as BacktestRunSummary[];
}

// Load one saved run in full, parsing result_json back into a BacktestResult.
export function getBacktestRun(id: number): SavedBacktestRun | null {
  const row = getDb()
    .prepare('SELECT * FROM backtest_runs WHERE id = ?')
    .get(id) as (BacktestRunSummary & { result_json: string }) | undefined;
  if (!row) return null;
  const { result_json, ...summary } = row;
  return { ...summary, result: JSON.parse(result_json) };
}

export function deleteBacktestRun(id: number): void {
  getDb().prepare('DELETE FROM backtest_runs WHERE id = ?').run(id);
}
