import { syncKlines } from './binance';

// CLI: npx ts-node fetch-binance.ts <SYMBOL> <INTERVAL> <START_YYYY-MM> <END_YYYY-MM> [--name "BTC/USDT 1m"]
const [symbol, interval, start, end] = process.argv.slice(2);
const nameIdx = process.argv.indexOf('--name');
const name    = nameIdx >= 0 ? process.argv[nameIdx + 1] : `${symbol} ${interval}`;

if (!symbol || !interval || !start || !end) {
  console.error('Usage: ts-node fetch-binance.ts <SYMBOL> <INTERVAL> <START_YYYY-MM> <END_YYYY-MM> [--name "BTC/USDT 1m"]');
  process.exit(1);
}

(async () => {
  console.log(`Syncing ${symbol} ${interval} ${start}..${end} → "${name}"`);
  const { rowsAdded, months } = await syncKlines(
    { symbol, interval, start, end, name },
    p => console.log(`  ${p.month}  ${p.status.padEnd(10)} +${p.rows} rows`),
  );
  console.log(`Done: ${rowsAdded} new rows across ${months} months → asset "${name}"`);
})().catch(e => { console.error(e); process.exit(1); });
