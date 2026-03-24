import axios from "axios";

export interface BinanceClosePoint {
  openTime: number;
  close: number;
}

export interface BinanceCandle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function intervalToMs(interval: string): number {
  const v = String(interval || "").trim().toLowerCase();
  if (v === "1m") return 60_000;
  if (v === "3m") return 3 * 60_000;
  if (v === "5m") return 5 * 60_000;
  if (v === "15m") return 15 * 60_000;
  if (v === "30m") return 30 * 60_000;
  if (v === "1h") return 60 * 60_000;
  throw new Error(`Unsupported Binance interval: ${interval}`);
}

export class BinanceClient {
  constructor(private readonly baseUrl = "https://api.binance.com") {}

  async getCloses(symbol: string, interval = "1m", limit = 150): Promise<number[]> {
    const candles = await this.getRecentCandles(symbol, interval, limit);
    return candles.map((row) => row.close).filter((n) => Number.isFinite(n));
  }

  async getRecentCandles(symbol: string, interval = "1m", limit = 150): Promise<BinanceCandle[]> {
    const { data } = await axios.get(`${this.baseUrl}/api/v3/klines`, {
      params: { symbol, interval, limit },
      timeout: 12000,
    });

    if (!Array.isArray(data)) {
      throw new Error("Invalid Binance klines response");
    }

    return data
      .map((row: unknown[]) => ({
        openTime: Number(row[0]),
        closeTime: Number(row[6]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
      }))
      .filter((row: BinanceCandle) => (
        Number.isFinite(row.openTime)
        && Number.isFinite(row.closeTime)
        && Number.isFinite(row.open)
        && Number.isFinite(row.high)
        && Number.isFinite(row.low)
        && Number.isFinite(row.close)
        && Number.isFinite(row.volume)
      ));
  }

  async getCloseNearTime(symbol: string, targetMs: number): Promise<number | null> {
    const startTime = Math.max(0, targetMs - 120_000);
    const { data } = await axios.get(`${this.baseUrl}/api/v3/klines`, {
      params: { symbol, interval: "1m", startTime, limit: 6 },
      timeout: 12000,
    });

    if (!Array.isArray(data) || data.length === 0) return null;
    const candles = data
      .map((row: unknown[]) => ({
        openTime: Number(row[0]),
        close: Number(row[4]),
      }))
      .filter((x: { openTime: number; close: number }) => Number.isFinite(x.openTime) && Number.isFinite(x.close))
      .sort((a: { openTime: number }, b: { openTime: number }) => a.openTime - b.openTime);

    if (!candles.length) return null;

    const after = candles.find((c: { openTime: number }) => c.openTime >= targetMs);
    if (after) return after.close;

    return candles[candles.length - 1].close;
  }

  async getCloseSeries(
    symbol: string,
    interval: string,
    startTime: number,
    endTime: number,
    maxPages = 50,
  ): Promise<BinanceClosePoint[]> {
    const intervalMs = intervalToMs(interval);
    const out: BinanceClosePoint[] = [];
    let cursor = Math.max(0, Math.floor(startTime));
    let pages = 0;

    while (cursor <= endTime && pages < maxPages) {
      pages += 1;
      const { data } = await axios.get(`${this.baseUrl}/api/v3/klines`, {
        params: {
          symbol,
          interval,
          startTime: cursor,
          endTime: Math.floor(endTime),
          limit: 1000,
        },
        timeout: 15000,
      });

      if (!Array.isArray(data) || data.length === 0) break;
      const rows = data
        .map((row: unknown[]) => ({
          openTime: Number(row[0]),
          close: Number(row[4]),
        }))
        .filter((x: BinanceClosePoint) => Number.isFinite(x.openTime) && Number.isFinite(x.close) && x.close > 0)
        .sort((a: BinanceClosePoint, b: BinanceClosePoint) => a.openTime - b.openTime);

      if (!rows.length) break;

      for (const r of rows) {
        if (r.openTime < startTime || r.openTime > endTime) continue;
        const last = out.length ? out[out.length - 1] : null;
        if (!last || last.openTime !== r.openTime) out.push(r);
      }

      const lastOpen = rows[rows.length - 1].openTime;
      const nextCursor = lastOpen + intervalMs;
      if (!Number.isFinite(nextCursor) || nextCursor <= cursor) break;
      cursor = nextCursor;
      if (lastOpen >= endTime) break;
      if (rows.length < 1000) break;
    }

    return out;
  }
}
