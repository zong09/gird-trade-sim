import express from 'express';
import path    from 'path';
import fs      from 'fs';

const LOG_DIR        = path.join(__dirname, 'data', 'logs');
const RETENTION_DAYS = 30;

const pad = (n: number) => String(n).padStart(2, '0');

// local-date YYYY-MM-DD (toISOString is UTC and could roll the day over)
function dateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// local timestamp with timezone offset, e.g. 2026-06-17T10:30:00.000+07:00
function timestamp(d: Date): string {
  const off  = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs  = Math.abs(off);
  const ms   = String(d.getMilliseconds()).padStart(3, '0');
  return `${dateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}` +
         `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function logFilePath(): string {
  return path.join(LOG_DIR, `${dateStr(new Date())}.log`);
}

function fmt(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error)    return arg.stack ?? arg.message;
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

function writeLine(level: string, args: unknown[]): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const msg = args.map(fmt).join(' ');
    fs.appendFileSync(logFilePath(), `[${timestamp(new Date())}] [${level}] ${msg}\n`);
  } catch (e) {
    // never let logging crash the server — surface to stderr only
    process.stderr.write(`logger write failed: ${(e as Error).message}\n`);
  }
}

// delete day-files older than RETENTION_DAYS
function cleanupOldLogs(): void {
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      const m = /^(\d{4})-(\d{2})-(\d{2})\.log$/.exec(f);
      if (!m) continue;
      const fileDate = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
      if (fileDate < cutoff) fs.unlinkSync(path.join(LOG_DIR, f));
    }
  } catch (e) {
    process.stderr.write(`logger cleanup failed: ${(e as Error).message}\n`);
  }
}

// patch console.* to tee into the daily file, run + schedule retention
export function initLogger(): void {
  const levels: Array<['log' | 'info' | 'warn' | 'error', string]> = [
    ['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR'],
  ];
  for (const [method, level] of levels) {
    const orig = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      orig(...args);
      writeLine(level, args);
    };
  }
  cleanupOldLogs();
  setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000).unref();
}

// log each request once it finishes: method url status durationMs
// skips noisy, frequently-polled paths so they don't spam the file being logged to
const SKIP_LOGGING_PATHS = ['/api/logs', '/api/sysmetrics'];
export const requestLogger: express.RequestHandler = (req, res, next) => {
  if (SKIP_LOGGING_PATHS.some(p => req.path.startsWith(p))) { next(); return; }
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
};

export interface LogFileInfo {
  date: string;   // YYYY-MM-DD
  sizeBytes: number;
}

// List day-files on disk, newest first.
export function listLogFiles(): LogFileInfo[] {
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs.readdirSync(LOG_DIR)
    .map(f => /^(\d{4}-\d{2}-\d{2})\.log$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => ({ date: m[1], sizeBytes: fs.statSync(path.join(LOG_DIR, m[0])).size }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

// Tail the last `maxLines` of a day's log file. Returns null if the date is
// malformed or the file doesn't exist — date is validated here (not just by
// the caller) since it flows straight into a filesystem path.
export function readLogFile(date: string, maxLines: number): { totalLines: number; content: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const filePath = path.join(LOG_DIR, `${date}.log`);
  if (!fs.existsSync(filePath)) return null;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  return { totalLines: lines.length, content: lines.slice(-maxLines).join('\n') };
}
