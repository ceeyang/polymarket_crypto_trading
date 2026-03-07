import axios from "axios";

export class BinanceClient {
  constructor(private readonly baseUrl = "https://api.binance.com") {}

  async getCloses(symbol: string, interval = "1m", limit = 150): Promise<number[]> {
    const { data } = await axios.get(`${this.baseUrl}/api/v3/klines`, {
      params: { symbol, interval, limit },
      timeout: 12000,
    });

    if (!Array.isArray(data)) {
      throw new Error("Invalid Binance klines response");
    }

    return data.map((row: unknown[]) => Number(row[4])).filter((n: number) => Number.isFinite(n));
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
}
