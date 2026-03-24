import type { BinanceCandle } from "../clients/binance.js";
import type { MarketTarget } from "../config.js";
import type { PredictionFactPack, SelectedMarket } from "../types.js";

function round(value: number | null, digits = 6): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function percentChange(candles: BinanceCandle[], minutes: number): number | null {
  if (candles.length <= minutes) return null;
  const last = candles[candles.length - 1]?.close;
  const prev = candles[candles.length - 1 - minutes]?.close;
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev <= 0) return null;
  return round((last / prev) - 1, 6);
}

function rangePct(candles: BinanceCandle[], minutes: number): number | null {
  if (candles.length < minutes) return null;
  const slice = candles.slice(-minutes);
  const last = slice[slice.length - 1]?.close;
  if (!Number.isFinite(last) || last <= 0) return null;
  let high = -Infinity;
  let low = Infinity;
  for (const row of slice) {
    if (row.high > high) high = row.high;
    if (row.low < low) low = row.low;
  }
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= 0 || low <= 0) return null;
  return round((high - low) / last, 6);
}

function realizedVolPct(candles: BinanceCandle[], minutes: number): number | null {
  if (candles.length < minutes + 1) return null;
  const slice = candles.slice(-(minutes + 1));
  const returns: number[] = [];
  for (let i = 1; i < slice.length; i += 1) {
    const prev = slice[i - 1]?.close;
    const cur = slice[i]?.close;
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0 || cur <= 0) continue;
    returns.push((cur / prev) - 1);
  }
  if (!returns.length) return null;
  const mean = returns.reduce((acc, x) => acc + x, 0) / returns.length;
  const variance = returns.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / returns.length;
  return round(Math.sqrt(Math.max(variance, 0)), 6);
}

function avgVolume(candles: BinanceCandle[], minutes: number, offset = 0): number | null {
  const end = candles.length - offset;
  const start = end - minutes;
  if (start < 0 || end <= start) return null;
  const slice = candles.slice(start, end);
  if (!slice.length) return null;
  const total = slice.reduce((acc, row) => acc + row.volume, 0);
  return total / slice.length;
}

function volumeRatio(candles: BinanceCandle[], shortMinutes: number, longMinutes: number): number | null {
  const shortAvg = avgVolume(candles, shortMinutes);
  const longAvg = avgVolume(candles, longMinutes);
  if (shortAvg == null || longAvg == null || longAvg <= 0) return null;
  return round(shortAvg / longAvg, 4);
}

export function buildMarketFactPack(input: {
  target: MarketTarget;
  market: SelectedMarket;
  candles: BinanceCandle[];
  fixedOrderPrice: number;
  timestampUtc?: string;
}): PredictionFactPack {
  const { target, market, candles, fixedOrderPrice } = input;
  const lastClose = candles[candles.length - 1]?.close ?? 0;

  return {
    timestampUtc: input.timestampUtc || new Date().toISOString(),
    coin: target.coin,
    symbol: target.symbol,
    horizonMin: target.horizonMin,
    market: {
      marketId: market.marketId,
      conditionId: market.conditionId,
      title: market.title,
      endDate: market.endDate,
      minsLeft: Number(market.minsLeft.toFixed(4)),
      liquidity: Number(market.liquidity.toFixed(4)),
      yesPrice: Number(market.yesPrice.toFixed(6)),
      noPrice: Number(market.noPrice.toFixed(6)),
      tickSize: Number(market.tickSize.toFixed(6)),
      fixedOrderPrice: Number(fixedOrderPrice.toFixed(6)),
    },
    price: {
      last: Number(lastClose.toFixed(6)),
      changePct: {
        m1: percentChange(candles, 1),
        m3: percentChange(candles, 3),
        m5: percentChange(candles, 5),
        m15: percentChange(candles, 15),
        m30: percentChange(candles, 30),
        m60: percentChange(candles, 60),
      },
      rangePct: {
        m5: rangePct(candles, 5),
        m15: rangePct(candles, 15),
        m30: rangePct(candles, 30),
      },
      realizedVolPct: {
        m5: realizedVolPct(candles, 5),
        m15: realizedVolPct(candles, 15),
        m30: realizedVolPct(candles, 30),
      },
      volumeRatio: {
        m5Over30: volumeRatio(candles, 5, 30),
        m15Over60: volumeRatio(candles, 15, 60),
      },
      recentCloses: candles.slice(-12).map((row) => Number(row.close.toFixed(6))),
    },
  };
}
