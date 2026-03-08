import type { Config, MarketTarget } from "../config.js";
import { BinanceClient } from "../clients/binance.js";
import { loadTrainedModel, predictWithTrainedModel } from "../strategy/trained-model.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const BACKTEST_DAYS_MAP: Record<number, number[]> = {
  5: [1, 3, 7],
  15: [1, 3, 7, 15],
  60: [1, 3, 7, 15],
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
  tradeSignalRate: number;
  maxConsecutivePredictionLosses: number;
  maxConsecutiveTradeLosses: number;
  dataPoints: number;
  dataStart: string;
  dataEnd: string;
}

export interface BacktestRecord {
  seq: number;
  entryTime: string;
  settleTime: string;
  entryPrice: number;
  settlePrice: number;
  predProbUp: number;
  predSide: "UP" | "DOWN";
  actualSide: "UP" | "DOWN";
  edge: number;
  win: boolean;
  traded: boolean;
  tradeWin: boolean | null;
}

export interface BacktestOutput {
  result: BacktestResult;
  records: BacktestRecord[];
}

export interface BacktestCompareCandidate {
  profileId: string;
  modelName: string;
  modelPath: string;
}

export interface BacktestCompareItem {
  rank: number | null;
  profileId: string;
  modelName: string;
  modelPath: string;
  ok: boolean;
  error?: string;
  result?: BacktestResult;
}

export interface BacktestCompareOutput {
  targetId: string;
  days: number;
  items: BacktestCompareItem[];
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

export async function runBacktestDetailed(
  cfg: Config,
  targetId: string,
  days: number,
  options?: { modelPath?: string },
): Promise<BacktestOutput> {
  const target = pickTarget(cfg, targetId);
  const allowedDays = getAllowedBacktestDays(target.horizonMin);
  if (!allowedDays.length) {
    throw new Error(`target horizon ${target.horizonMin}m is not supported in backtest`);
  }
  if (!allowedDays.includes(days)) {
    throw new Error(`invalid days=${days} for ${target.horizonMin}m, allowed=${allowedDays.join(",")}`);
  }

  const overrideModelPath = options?.modelPath?.trim();
  const modelPath = overrideModelPath || target.modelPath?.trim() || cfg.trainedModelPath;
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

  const minuteMs = 60_000;
  const lookbackMinutes = Math.max(60, Math.floor(target.lookbackMinutes ?? cfg.lookbackMinutes));
  const horizonSteps = Math.max(1, Math.floor(target.horizonMin));
  const horizonMs = horizonSteps * minuteMs;
  const minEdge = Math.max(0, Number(target.minEdge ?? cfg.minEdge));

  const nowMs = Date.now();
  const evalStartRaw = nowMs - days * DAY_MS;
  const evalStartMs = Math.floor(evalStartRaw / horizonMs) * horizonMs;
  const evalEndMs = Math.floor(nowMs / horizonMs) * horizonMs;
  const fetchStart = evalStartMs - (lookbackMinutes + horizonSteps + 5) * minuteMs;
  const fetchEnd = nowMs;

  const binance = new BinanceClient();
  const rows = await binance.getCloseSeries(symbol, "1m", fetchStart, fetchEnd, 120);
  if (rows.length < lookbackMinutes + horizonSteps + 20) {
    throw new Error(`not enough kline data for ${targetId}; got=${rows.length}`);
  }

  const rowByTime = new Map<number, { openTime: number; close: number }>();
  const idxByTime = new Map<number, number>();
  for (let i = 0; i < rows.length; i += 1) {
    rowByTime.set(rows[i].openTime, rows[i]);
    idxByTime.set(rows[i].openTime, i);
  }

  const gapPrefix = new Array(rows.length + 1).fill(0);
  for (let i = 1; i < rows.length; i += 1) {
    const gap = rows[i].openTime - rows[i - 1].openTime !== minuteMs ? 1 : 0;
    gapPrefix[i + 1] = gapPrefix[i] + gap;
  }
  const isContinuous = (startIdx: number, endIdx: number): boolean => {
    if (startIdx < 0 || endIdx <= startIdx) return false;
    return gapPrefix[endIdx + 1] - gapPrefix[startIdx + 1] === 0;
  };

  let sampleCount = 0;
  let predictionWins = 0;
  let tradeCount = 0;
  let tradeWins = 0;
  let maxConsecutivePredictionLosses = 0;
  let maxConsecutiveTradeLosses = 0;
  let currentPredictionLosses = 0;
  let currentTradeLosses = 0;
  const records: BacktestRecord[] = [];

  for (let i = lookbackMinutes - 1; i < rows.length; i += 1) {
    const entry = rows[i];
    const entryTime = entry.openTime;
    if (entryTime < evalStartMs) continue;
    if (entryTime + horizonMs > evalEndMs) continue;
    // 仅使用 Polymarket 盘口窗口起点样本（xx:00/05/10..., xx:00/15/30/45）。
    if (entryTime % horizonMs !== 0) continue;

    const futureTime = entryTime + horizonMs;
    const future = rowByTime.get(futureTime);
    const futureIdx = idxByTime.get(futureTime);
    if (!future || futureIdx == null) continue;

    const startIdx = i - lookbackMinutes + 1;
    if (!isContinuous(startIdx, i)) continue;
    if (!isContinuous(i, futureIdx)) continue;

    const current = entry.close;
    if (!Number.isFinite(current) || !Number.isFinite(future.close) || current <= 0 || future.close <= 0) continue;
    const window = rows.slice(startIdx, i + 1).map((x) => x.close);
    const pred = predictWithTrainedModel(window, model);
    if (!pred) continue;

    const predUp = pred.probUp >= 0.5;
    const actualUp = future.close >= current;
    const win = predUp === actualUp;

    sampleCount += 1;
    if (win) predictionWins += 1;
    if (win) {
      currentPredictionLosses = 0;
    } else {
      currentPredictionLosses += 1;
      if (currentPredictionLosses > maxConsecutivePredictionLosses) {
        maxConsecutivePredictionLosses = currentPredictionLosses;
      }
    }

    const edge = Math.abs(pred.probUp - 0.5);
    let traded = false;
    let tradeWin: boolean | null = null;
    if (edge >= minEdge) {
      tradeCount += 1;
      traded = true;
      tradeWin = win;
      if (win) {
        tradeWins += 1;
        currentTradeLosses = 0;
      } else {
        currentTradeLosses += 1;
        if (currentTradeLosses > maxConsecutiveTradeLosses) {
          maxConsecutiveTradeLosses = currentTradeLosses;
        }
      }
    }

    records.push({
      seq: sampleCount,
      entryTime: new Date(entryTime).toISOString(),
      settleTime: new Date(futureTime).toISOString(),
      entryPrice: current,
      settlePrice: future.close,
      predProbUp: pred.probUp,
      predSide: predUp ? "UP" : "DOWN",
      actualSide: actualUp ? "UP" : "DOWN",
      edge,
      win,
      traded,
      tradeWin,
    });
  }

  if (sampleCount <= 0) {
    throw new Error(`no valid backtest samples for ${targetId}`);
  }

  return {
    result: {
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
      tradeSignalRate: toRate(tradeCount, sampleCount),
      maxConsecutivePredictionLosses,
      maxConsecutiveTradeLosses,
      dataPoints: rows.length,
      dataStart: new Date(rows[0].openTime).toISOString(),
      dataEnd: new Date(rows[rows.length - 1].openTime).toISOString(),
    },
    records,
  };
}

export async function runBacktest(
  cfg: Config,
  targetId: string,
  days: number,
  options?: { modelPath?: string },
): Promise<BacktestResult> {
  const out = await runBacktestDetailed(cfg, targetId, days, options);
  return out.result;
}

function compareByPerformance(a: BacktestResult, b: BacktestResult): number {
  const w = b.tradeWinRate - a.tradeWinRate;
  if (w !== 0) return w;
  const c = b.tradeCount - a.tradeCount;
  if (c !== 0) return c;
  const p = b.predictionWinRate - a.predictionWinRate;
  if (p !== 0) return p;
  return b.sampleCount - a.sampleCount;
}

export async function runBacktestCompare(
  cfg: Config,
  targetId: string,
  days: number,
  candidates: BacktestCompareCandidate[],
): Promise<BacktestCompareOutput> {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("no model candidates for compare");
  }

  const dedup = new Map<string, BacktestCompareCandidate>();
  for (const c of candidates) {
    const modelPath = String(c.modelPath || "").trim();
    if (!modelPath) continue;
    const key = `${String(c.profileId || "").trim()}::${modelPath}`;
    if (!dedup.has(key)) {
      dedup.set(key, {
        profileId: String(c.profileId || "").trim() || "unknown",
        modelName: String(c.modelName || "").trim() || modelPath,
        modelPath,
      });
    }
  }
  const list = [...dedup.values()];
  if (!list.length) {
    throw new Error("no valid model candidates for compare");
  }

  const items: BacktestCompareItem[] = [];
  for (const c of list) {
    try {
      const out = await runBacktestDetailed(cfg, targetId, days, { modelPath: c.modelPath });
      items.push({
        rank: null,
        profileId: c.profileId,
        modelName: c.modelName,
        modelPath: c.modelPath,
        ok: true,
        result: out.result,
      });
    } catch (err) {
      items.push({
        rank: null,
        profileId: c.profileId,
        modelName: c.modelName,
        modelPath: c.modelPath,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const success = items.filter((x) => x.ok && x.result).sort((a, b) => compareByPerformance(a.result!, b.result!));
  const failed = items.filter((x) => !x.ok);
  for (let i = 0; i < success.length; i += 1) {
    success[i].rank = i + 1;
  }

  return {
    targetId,
    days,
    items: [...success, ...failed],
  };
}
