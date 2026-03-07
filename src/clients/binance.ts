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
}
