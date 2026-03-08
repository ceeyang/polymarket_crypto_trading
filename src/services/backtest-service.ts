import type { Config, MarketTarget } from "../config.js";
import { BinanceClient } from "../clients/binance.js";
import { loadTrainedModel, predictWithTrainedModel } from "../strategy/trained-model.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const BACKTEST_DAYS_MAP: Record<number, number[]> = {
  5: [1, 3, 7],
  15: [1, 3, 7, 15],
};

export interface BacktestResult {
  targetId: string;
  coin: string;
  horizonMin: number;
  symbol: string;
  modelPath: string;
  days: number;
  minEdge: number;
  lookbackMinutes: number;
  sampleCount: number;
  predictionWins: number;
  predictionWinRate: number;
  tradeCount: number;
  tradeWins: number;
  tradeWinRate: number;
  totalWinRate: number;
  tradeSignalRate: number;
  dataPoints: number;
  dataStart: string;
  dataEnd: string;
}

export function getAllowedBacktestDays(horizonMin: number): number[] {
  return BACKTEST_DAYS_MAP[horizonMin] ?? [];
}

function pickTarget(cfg: Config, targetId: string): MarketTarget {
  const target = cfg.targets.find((t) => t.id === targetId);
  if (!target) {
    throw new Error(`target not found: ${targetId}`);
  }
  return target;
}

function toRate(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return numerator / denominator;
}

export async function runBacktest(cfg: Config, targetId: string, days: number): Promise<BacktestResult> {
  const target = pickTarget(cfg, targetId);
  const allowedDays = getAllowedBacktestDays(target.horizonMin);
  if (!allowedDays.length) {
    throw new Error(`target horizon ${target.horizonMin}m is not supported in backtest`);
  }
  if (!allowedDays.includes(days)) {
    throw new Error(`invalid days=${days} for ${target.horizonMin}m, allowed=${allowedDays.join(",")}`);
  }

  const modelPath = target.modelPath?.trim() || cfg.trainedModelPath;
  const model = loadTrainedModel(modelPath);
  if (!model) {
    throw new Error(`model not found or invalid: ${modelPath}`);
  }

  const symbol = (target.symbol || `${target.coin}USDT`).toUpperCase();
  if (Number(model.horizonMin) !== Number(target.horizonMin)) {
    throw new Error(`model horizon mismatch: model=${model.horizonMin}m target=${target.horizonMin}m`);
  }
  if (String(model.symbol || "").toUpperCase() !== symbol) {
    throw new Error(`model symbol mismatch: model=${model.symbol} target=${symbol}`);
  }

  const lookbackMinutes = Math.max(60, Math.floor(target.lookbackMinutes ?? cfg.lookbackMinutes));
  const horizonSteps = Math.max(1, Math.floor(target.horizonMin));
  const minEdge = Math.max(0, Number(target.minEdge ?? cfg.minEdge));

  const nowMs = Date.now();
  const fetchStart = nowMs - days * DAY_MS - (lookbackMinutes + horizonSteps + 5) * 60_000;
  const fetchEnd = nowMs;

  const binance = new BinanceClient();
  const rows = await binance.getCloseSeries(symbol, "1m", fetchStart, fetchEnd, 120);
  if (rows.length < lookbackMinutes + horizonSteps + 20) {
    throw new Error(`not enough kline data for ${targetId}; got=${rows.length}`);
  }

  const closes = rows.map((x) => x.close);
  let sampleCount = 0;
  let predictionWins = 0;
  let tradeCount = 0;
  let tradeWins = 0;

  for (let i = lookbackMinutes - 1; i + horizonSteps < closes.length; i += 1) {
    const current = closes[i];
    const future = closes[i + horizonSteps];
    if (!Number.isFinite(current) || !Number.isFinite(future) || current <= 0 || future <= 0) continue;

    const window = closes.slice(i - lookbackMinutes + 1, i + 1);
    const pred = predictWithTrainedModel(window, model);
    if (!pred) continue;

    const predUp = pred.probUp >= 0.5;
    const actualUp = future > current;
    const win = predUp === actualUp;

    sampleCount += 1;
    if (win) predictionWins += 1;

    const edge = Math.abs(pred.probUp - 0.5);
    if (edge >= minEdge) {
      tradeCount += 1;
      if (win) tradeWins += 1;
    }
  }

  if (sampleCount <= 0) {
    throw new Error(`no valid backtest samples for ${targetId}`);
  }

  return {
    targetId: target.id,
    coin: target.coin,
    horizonMin: target.horizonMin,
    symbol,
    modelPath,
    days,
    minEdge,
    lookbackMinutes,
    sampleCount,
    predictionWins,
    predictionWinRate: toRate(predictionWins, sampleCount),
    tradeCount,
    tradeWins,
    tradeWinRate: toRate(tradeWins, tradeCount),
    totalWinRate: toRate(tradeWins, sampleCount),
    tradeSignalRate: toRate(tradeCount, sampleCount),
    dataPoints: rows.length,
    dataStart: new Date(rows[0].openTime).toISOString(),
    dataEnd: new Date(rows[rows.length - 1].openTime).toISOString(),
  };
}
