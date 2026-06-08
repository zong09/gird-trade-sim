# Grid Trading Backtest & Monte Carlo Simulation — Project Spec

## Overview

TypeScript project สำหรับ:
1. **Backtest** grid trading strategy บน BTC/THB ด้วยข้อมูล OHLC รายนาที
2. **Monte Carlo simulation** เพื่อ predict ผลตอบแทน 1 ปีข้างหน้า
3. **Recommend parameters** (min/max price, จำนวน grid, เงินลงทุน) ที่ได้ APY ใกล้ target

---

## Data Format

ไฟล์ข้อมูล: `ohlc_service.hour_ohlc_chart_data.json`

```ts
// แต่ละ record = 1 ชั่วโมง
{
  timestamp: { $numberLong: string },   // Unix timestamp (seconds)
  base: "BTC", quote: "THB",
  aggregated_point: [ts, open, high, low, close, volume, source],  // hourly OHLC
  raw_points: [ts, open, high, low, close, volume, source][],      // minute OHLC (60 จุด/ชั่วโมง)
  point_count: 60
}
```

- ข้อมูลครอบคลุม: **มี.ค. 2023 – มิ.ย. 2026** (~3 ปี)
- `raw_points` = ข้อมูลรายนาที (interval 60 วินาที)
- `aggregated_point` = ข้อมูลรายชั่วโมง

---

## Grid Trading Logic

### กลไก
- แบ่ง price range [minPrice, maxPrice] เป็น N ช่อง (N+1 levels)
- ทุน `capitalPerGrid = investment / numGrids`
- **เมื่อราคาลงแตะ levels[i]** → Buy (ซื้อ BTC ด้วย capitalPerGrid)
- **เมื่อราคาขึ้นแตะ levels[i+1]** → Sell (ขาย BTC ที่ซื้อมา)
- กำไรต่อ round trip = `spacing/midPrice - 2*feeRate`

### Simulation ต่อ candle
```
Sell pass: for each grid i → if pos[i] && high >= levels[i+1] → execute sell
Buy  pass: for each grid i → if !pos[i] && low <= levels[i]   → set pos[i] = true
```

### ค่า fee
- `feeRate = 0.0025` (0.25% ต่อ transaction)
- ทุก round trip เสีย fee 2 ครั้ง (buy + sell)

---

## Backtest Engine (`engine.ts`)

```ts
function runBacktest(candles: Candle[], params: GridParams): BacktestResult
```

**Input:**
- `candles` — sorted minute candles `[{ts, open, high, low, close}]`
- `params` — `{ minPrice, maxPrice, numGrids, investment, feeRate? }`

**Output:**
```ts
{
  pnl, fees, trades,
  apy,              // (pnl / investment / years) * 100
  spacing,          // (maxPrice - minPrice) / numGrids
  spacingPct,       // spacing / midPrice * 100
  profitPerRoundTrip // spacingPct - feeRate*2*100
}
```

**ผล backtest พ.ค. 2025 – พ.ค. 2026 (best config):**
| Parameter | ค่า |
|---|---|
| Min / Max price | 2,440,000 – 3,640,000 THB |
| Grids | 30 |
| Spacing | 40,000 THB (1.32%) |
| APY | 8.22% |
| กำไร (100k) | 8,908 THB |
| ค่า fee | 5,686 THB |
| เทรด/ปี | 678 ครั้ง |

---

## Monte Carlo Simulation (`simulator.ts`)

### วิธีการ: Block Bootstrap
1. Aggregate minute candles → hourly candles
2. คำนวณ hourly log-returns และ H/L ratio จากข้อมูลอดีต
3. สุ่มบล็อก returns (blockSize=48 ชั่วโมง) มาต่อกันเป็น path 1 ปี → ทำ 300 รอบ
4. รัน grid backtest บนแต่ละ path → ได้ APY 300 ค่า
5. คำนวณ P10, P25, Median, P75, P90, P(≥targetApy)

```ts
function runMonteCarlo(opts: MonteCarloOptions): SimResult[]
function getRecommendation(results: SimResult[], opts: RecommendationOptions): Recommendation
```

**Historical stats (training data 2 ปี):**
- Annual volatility: **46.9%**
- Annual drift: **-9.7%**
- Start price: **~2.05M THB**
- Median end price (1y): **~1.93M THB**

### ผล simulation (300 sims, 1 ปีข้างหน้า)
| Config | P10 | P25 | Median | P75 | P90 | P(≥8%) |
|---|---|---|---|---|---|---|
| VeryWide-50 (1.5M–4.0M) | 3.3% | 5.9% | 8.0% | 9.5% | 10.4% | 50% |
| **Wide-40 (1.5M–3.5M)** | **4.1%** | **7.2%** | **9.8%** | **11.5%** | **12.7%** | **70%** |
| Wide-30 (1.7M–3.3M) | 2.9% | 6.1% | 10.9% | 13.9% | 15.4% | 66% |
| Mid-25 (1.9M–3.1M) | 1.4% | 4.0% | 10.0% | 15.4% | 18.3% | 60% |
| Narrow-20 (2.0M–3.0M) | 0.4% | 2.9% | 9.1% | 16.2% | 20.4% | 54% |

**Recommendation (target APY 8%, target profit 50,000 THB/ปี):**
| Strategy | Config | APY | Investment | โอกาส ≥8% |
|---|---|---|---|---|
| Balanced (แนะนำ) | Wide-40 | 9.83% | 509,000 THB | 70% |
| Safe | Wide-40 | 9.83% | 509,000 THB | 70% |
| Aggressive | Wide-30 | 10.87% | 460,000 THB | 66% |

---

## File Structure

```
grid-backtest/
├── types.ts       — interfaces: Candle, GridParams, BacktestResult, SimResult, Recommendation, Config
├── loader.ts      — loadCandles(filePath, period?) → Candle[]
│                    รองรับ 3 formats: raw_points / flat object / flat array
├── engine.ts      — runBacktest(candles, params) → BacktestResult
├── simulator.ts   — runMonteCarlo(opts) → SimResult[]
│                    getRecommendation(results, opts) → Recommendation
├── run.ts         — entry point: backtest → simulation → recommendation → output.json
├── config.json    — configuration ทั้งหมด
└── tsconfig.json
```

---

## Config Schema

```json
{
  "dataFile": "path to JSON data",
  "investment": 100000,
  "feeRate": 0.0025,

  "backtest": {
    "period": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
    "minPrice": number,
    "maxPrice": number,
    "numGrids": number
  },

  "simulation": {
    "trainingPeriod": { "start": "YYYY-MM-DD" },
    "targetApy": 8,
    "targetProfitThb": 50000,
    "numSims": 300,
    "hoursAhead": 8760,
    "blockSize": 48,
    "seed": 42,
    "paramSets": [
      { "label": "...", "minPrice": number, "maxPrice": number, "numGrids": number }
    ]
  }
}
```

---

## Run Commands

```bash
npx ts-node run.ts       # รัน backtest + simulation + recommendation
npm run build            # compile TypeScript → dist/
npm run run              # รัน compiled version
```

Output: `output.json` — `{ backtest, simulation, recommendations }`

---

## Key Insights

1. **Investment ไม่มีผลต่อ APY** — scale เชิงเส้น เงินลงทุนคำนวณจาก `targetProfit / (APY/100)`
2. **Range กว้าง = ความเสี่ยงต่ำ** — P10 สูงกว่า (worst case ดีกว่า) แต่ median ต่ำกว่า
3. **Range แคบ = variance สูง** — median ดูดีแต่ P10 เกือบ 0% ในบางสถานการณ์
4. **Wide-40 (1.5M–3.5M, 40 grids)** คือ optimal สำหรับ target 8% APY — โอกาสสูงสุด 70% และ P10 ยัง +4.1%
5. **Grid trading เหมาะตลาด sideways/ขาลง** ให้ผลสม่ำเสมอ ต่างจาก Buy & Hold ที่ผันผวนตามราคา BTC
