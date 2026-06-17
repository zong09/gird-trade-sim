# Plan: ย้าย candle store → SQLite + fetch Binance Vision monthly klines

## Context

ต้องการดึง 1m klines จาก data.binance.vision (2017→ปัจจุบัน) มารวมใช้งาน — ที่ scale นี้ ~4.6M แถว/210MB ต่อ symbol. เก็บเป็น JSON file แล้ว `JSON.parse` ทั้งก้อนทุกครั้ง (RAM ~1.5GB) ไม่ไหว.

**Decisions (ยืนยันกับ user):**

- เก็บ candle ทั้งหมดใน **SQLite ล้วน** (migrate JSON เดิมเข้า DB ด้วย)
- driver = **better-sqlite3** (sync API เข้ากับ `loadCandles` ที่ sync อยู่)
- รองรับ Binance kline เก็บ **1m เต็ม**, range query ตอน backtest → โหลดเฉพาะช่วง
- **UI มีปุ่ม Sync ดึง data จาก Binance ได้เอง + search crypto** (ค้นหา symbol จาก Binance exchangeInfo) — ไม่ต้องใช้ CLI

**ผล:** backtest/sim query เฉพาะช่วงเวลาที่ใช้ (เช่น 1 ปี ~525k แถว) แทน parse ทั้ง 4.6M; เพิ่มเดือนใหม่แบบ incremental (`INSERT OR IGNORE`, dup กันด้วย PK)

## Schema — `data/candles.db`

```sql
CREATE TABLE IF NOT EXISTS candles (
  symbol TEXT NOT NULL,            -- asset name เช่น "BTC/USDT 1m"
  ts     INTEGER NOT NULL,         -- วินาที (normalize จาก μs/ms)
  open REAL, high REAL, low REAL, close REAL,
  PRIMARY KEY (symbol, ts)         -- เป็น index สำหรับ range query ในตัว
);
```

`asset-config.json` ยังอยู่ — ใช้เป็น **registry ชื่อ asset + ลำดับ dropdown** (drag-reorder เดิมใช้ได้); `dataFile` กลายเป็น optional/legacy ไม่ใช้โหลดแล้ว

## Files

### NEW `db.ts` (shared module)

- เปิด DB (`new Database(path)`), `PRAGMA journal_mode=WAL`, ensure schema
- `insertCandles(symbol, Candle[])` — prepared `INSERT OR IGNORE` ใน transaction (เร็ว)
- `queryCandles(symbol, period): Candle[]` — `SELECT ts,open,high,low,close WHERE symbol=? AND ts>=? AND ts<=? ORDER BY ts` (แปลง period date→ts เหมือน loader.ts:36-37)
- `listSymbols()` — `SELECT symbol, COUNT(*) n, MIN(ts) first, MAX(ts) last GROUP BY symbol`
- `deleteSymbol(symbol)`

### `loader.ts` — แยกหน้าที่

- `loadCandles(symbol, period)` → เรียก `db.queryCandles` (เปลี่ยน signature จาก `(filePath, period)` → `(symbol, period)`)
- เก็บ logic detect 4 JSON format เดิมไว้เป็น `parseCandleData(raw): Candle[]` (export) — ใช้ตอน import/migrate เท่านั้น

### NEW `binance.ts` (shared core — ใช้ทั้ง CLI และ server)

- `searchSymbols(query): {symbol,base,quote}[]` — ดึง `https://api.binance.com/api/v3/exchangeInfo` ครั้งเดียว **cache ใน memory** (TTL) แล้ว filter ด้วย query (match symbol/base) คืน top ~50; ใช้ `base/quote` มาประกอบชื่อ asset "BTC/USDT" + ใช้ quote กับ currency display (server.ts:103)
- `syncKlines({symbol, interval, start, end, name}, onProgress?): {rowsAdded, months}` — core download+merge:
  - cache dir `data/binance/`; ต่อเดือน: ถ้า `{SYMBOL}-{INTERVAL}-{YYYY-MM}.csv` มี → ใช้เลย; ไม่มี → `curl -fsSL` ZIP จาก `https://data.binance.vision/data/spot/monthly/klines/{SYMBOL}/{INTERVAL}/{...}.zip` แล้ว `unzip -p` (zero npm dep, `child_process.execFileSync`); 404 → `onProgress(skip)` + ข้าม
  - parse CSV (ไม่มี header): col `[0]=ts [1..4]=OHLC`; ข้ามบรรทัดถ้า cell แรกไม่ใช่ตัวเลข; normalize ts→วินาที (`>1e15 /1e6` μs · `>1e12 /1e3` ms · else s)
  - `db.insertCandles(name, candles)` (INSERT OR IGNORE dedup ข้ามเดือน/รอบรันเอง) + register asset-config ถ้ายังไม่มี
  - เรียก `onProgress({month, rows, status})` ต่อเดือน (ให้ server stream ได้)

### NEW `fetch-binance.ts` (CLI — thin wrapper)

```bash
npx ts-node fetch-binance.ts BTCUSDT 1m 2024-06 2026-05 --name "BTC/USDT 1m"
```

เรียก `binance.syncKlines(...)` print progress ลง console

### NEW `migrate-to-sqlite.ts` (one-time)

- อ่าน `asset-config.json` → แต่ละ asset ที่มี `dataFile` JSON: อ่านไฟล์ → `parseCandleData` → `db.insertCandles(name, ...)`
- รันครั้งเดียวเพื่อย้าย BTC/THB, BTC/USDT เดิมเข้า DB

### `server.ts`

- `/api/run`: `loadCandles(asset.name, period)` (ไม่ใช้ dataFile)
- upload: แทนที่จะเซฟ .json → `parseCandleData(JSON.parse(buf))` แล้ว `db.insertCandles(assetName, ...)` + register (ใช้ memoryStorage แทน diskStorage); ยังจำกัด `.json`
- `/api/files` → `db.listSymbols()` (คืน name, จำนวนแถว, ช่วงวันที่)
- DELETE → `db.deleteSymbol(name)` + ลบ asset-config entry
- reorder → เหมือนเดิม (asset-config order)
- **NEW `GET /api/binance/symbols?q=`** → `binance.searchSymbols(q)` คืน `[{symbol,base,quote}]` (สำหรับ search box)
- **NEW `GET /api/binance/sync`** (Server-Sent Events) query `symbol,interval,start,end,name` → set header `text/event-stream`, เรียก `binance.syncKlines(..., onProgress)` แล้ว `res.write('data: '+JSON.stringify(progress))` ต่อเดือน, จบด้วย event `done {rowsAdded}`. ใช้ SSE เพราะ range ยาว (2017→now ~106 เดือน) ใช้เวลาหลายนาที — UI จะได้เห็น progress สด (server.timeout 10 นาทีตั้งไว้แล้ว server.ts:187)

### `public/index.html` — Sync from Binance panel (ใน Data Files tab)

- **search box**: พิมพ์ชื่อ crypto → debounce → `GET /api/binance/symbols?q=` → dropdown ผลลัพธ์ (แสดง "BTC/USDT") เลือกได้
- controls: interval select (1m/5m/15m/1h/4h/1d), start/end month input, asset name (default `${base}/${quote} ${interval}`)
- **ปุ่ม Sync**: เปิด `EventSource('/api/binance/sync?...')` → append progress log ต่อเดือน (เดือน/แถว/skip) → จบแล้ว refresh asset dropdown + file list
- reuse pattern fetch/showPopup ที่มีใน index.html อยู่แล้ว

### `run.ts`

- `loadCandles(asset.name, period)` (2 จุด: backtest + sim training)

### `types.ts`

- `Asset.dataFile` → optional (`dataFile?: string`)

### `package.json`

- เพิ่ม `better-sqlite3` (deps) + `@types/better-sqlite3` (devDeps); `npm install` (native build)

## Reuse / ไม่แตะ

- `engine.ts`, `simulator.ts` ทำงานบน `Candle[]` — **ไม่ต้องแก้**
- `period→ts` logic (loader.ts:36-37) ย้ายไป `db.queryCandles`
- asset registration pattern (server.ts:140-145)

## หมายเหตุ

- ts เก็บเป็นวินาที (เหมือน format เดิม) → engine/snapshot (engine.ts:52) ใช้ได้ทันที
- better-sqlite3 ต้อง native build ตอน install (ปกติมี prebuilt) — ระบุใน README
- system deps: `curl` + `unzip` (macOS built-in) สำหรับ fetch
- (optional, ทำทีหลัง) sim training period ที่ยาวมาก: เพิ่ม SQL hourly bucket (`GROUP BY ts/3600`) ลดแถวก่อนส่ง `toHourly` (simulator.ts:57) — ตอนนี้ยังโหลด 1m เต็มช่วง training

## Verification

1. `npm install` (better-sqlite3 build ผ่าน) แล้ว `npx tsc --noEmit`
2. **migrate:** `npx ts-node migrate-to-sqlite.ts` → `db.listSymbols()` เห็น BTC/THB, BTC/USDT เดิม
3. **fetch (offline, ใช้ CSV ที่มี):** `npx ts-node fetch-binance.ts BTCUSDT 1m 2026-05 2026-05 --name "BTC/USDT 1m"` → DB +~44,640 แถว, asset-config มี entry; candle แรก ts ≈ 1777593600 (วินาที, 2026)
4. **backtest:** `npx ts-node run.ts "BTC/USDT 1m"` → ออกผล, RAM ต่ำ (query เฉพาะ period), ไม่ต้อง --max-old-space-size
5. **rerun fetch เดือนเดิม** → จำนวนแถวเท่าเดิม (INSERT OR IGNORE dedup)
6. **network:** ดึงเดือนที่ยังไม่ cache 1 เดือน → สำเร็จ; เดือนปลอม → warn+skip ไม่ crash
7. **web:** `npm run server` → dropdown เห็น asset, รันได้, Files tab list จาก DB, upload JSON เข้า DB, delete ลบ
8. **Sync UI:** Data Files tab → search "btc" เห็น BTC/USDT ฯลฯ → เลือก + interval 1m + ช่วงสั้น (1 เดือน) → ปุ่ม Sync → progress log วิ่ง → จบแล้ว asset ใหม่โผล่ใน dropdown รัน backtest ได้
