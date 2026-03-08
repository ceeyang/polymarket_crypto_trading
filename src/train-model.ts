import "dotenv/config";

import axios from "axios";

import { loadConfig, type MarketTarget, type SupportedHorizon, type TrainingConfig } from "./config.js";
import { FEATURE_NAMES, buildFeatureVector } from "./strategy/features.js";
import { saveTrainedModel } from "./strategy/trained-model.js";

interface Candle {
  openTime: number;
  close: number;
}

interface Sample {
  timeMs: number;
  x: number[];
  y: number;
}

interface Metrics {
  accuracy: number;
  brier: number;
  logLoss: number;
  precision: number;
  recall: number;
  f1: number;
}

interface TrainJob {
  targetId: string;
  symbol: string;
  horizonMin: number;
  modelOut: string;
  paramProfile: string;
  lookback: number;
  stepMin: number;
  valDays: number;
  epochs: number;
  lr: number;
  l2: number;
  patience: number;
  startMs: number;
  endMs: number;
}

interface HorizonTrainingDefaults {
  lookbackMin: number;
  stepMin: number;
  valDays: number;
  epochs: number;
  learningRate: number;
  l2: number;
  patience: number;
}

function sigmoid(x: number): number {
  if (x > 30) return 1;
  if (x < -30) return 0;
  return 1 / (1 + Math.exp(-x));
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

function splitByTime(samples: Sample[], valDays: number): { train: Sample[]; val: Sample[] } {
  if (samples.length < 50) return { train: samples, val: [] };
  const valMs = Math.max(1, valDays) * 24 * 60 * 60 * 1000;
  const endMs = samples[samples.length - 1].timeMs;
  const valStart = endMs - valMs;
  const train = samples.filter((s) => s.timeMs < valStart);
  const val = samples.filter((s) => s.timeMs >= valStart);
  if (train.length < 30 || val.length < 10) {
    const cut = Math.max(20, Math.floor(samples.length * 0.8));
    return { train: samples.slice(0, cut), val: samples.slice(cut) };
  }
  return { train, val };
}

function fitScaler(xs: number[][]): { means: number[]; stds: number[] } {
  const d = xs[0]?.length ?? 0;
  const means = new Array(d).fill(0);
  const stds = new Array(d).fill(1);
  for (let j = 0; j < d; j += 1) {
    let m = 0;
    for (let i = 0; i < xs.length; i += 1) m += xs[i][j];
    m /= Math.max(1, xs.length);
    means[j] = m;
    let v = 0;
    for (let i = 0; i < xs.length; i += 1) {
      const diff = xs[i][j] - m;
      v += diff * diff;
    }
    v /= Math.max(1, xs.length);
    stds[j] = Math.sqrt(v) + 1e-9;
  }
  return { means, stds };
}

function transform(xs: number[][], means: number[], stds: number[]): number[][] {
  return xs.map((row) => row.map((v, j) => (v - means[j]) / stds[j]));
}

function predictBatch(xs: number[][], w: number[], b: number): number[] {
  return xs.map((x) => sigmoid(dot(x, w) + b));
}

function computeMetrics(probs: number[], labels: number[]): Metrics {
  if (!probs.length) return { accuracy: 0, brier: 0, logLoss: 0, precision: 0, recall: 0, f1: 0 };
  let correct = 0;
  let brier = 0;
  let logLoss = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < probs.length; i += 1) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, probs[i]));
    const y = labels[i];
    const pred = p >= 0.5 ? 1 : 0;
    if (pred === y) correct += 1;
    brier += (p - y) ** 2;
    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    if (pred === 1 && y === 1) tp += 1;
    if (pred === 1 && y === 0) fp += 1;
    if (pred === 0 && y === 1) fn += 1;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    accuracy: correct / probs.length,
    brier: brier / probs.length,
    logLoss: logLoss / probs.length,
    precision,
    recall,
    f1,
  };
}

function computeLoss(probs: number[], labels: number[], w: number[], l2: number): number {
  if (!probs.length) return 0;
  let nll = 0;
  for (let i = 0; i < probs.length; i += 1) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, probs[i]));
    const y = labels[i];
    nll += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  const reg = l2 * w.reduce((acc, wi) => acc + wi * wi, 0);
  return nll / probs.length + reg;
}

async function fetchKlinesRange(symbol: string, startMs: number, endMs: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const { data } = await axios.get("https://api.binance.com/api/v3/klines", {
      params: { symbol, interval: "1m", startTime: cursor, endTime: endMs, limit: 1000 },
      timeout: 15000,
    });
    if (!Array.isArray(data) || data.length === 0) break;
    for (const row of data) {
      const openTime = Number(row[0]);
      const close = Number(row[4]);
      if (!Number.isFinite(openTime) || !Number.isFinite(close)) continue;
      out.push({ openTime, close });
    }
    const lastOpen = Number(data[data.length - 1][0]);
    if (!Number.isFinite(lastOpen)) break;
    cursor = lastOpen + 60_000;
    if (data.length < 1000) break;
  }
  const dedup = new Map<number, Candle>();
  for (const c of out) dedup.set(c.openTime, c);
  return [...dedup.values()].sort((a, b) => a.openTime - b.openTime);
}

function buildSamples(candles: Candle[], lookback: number, horizonMin: number, stepMin: number, startMs: number, endMs: number): Sample[] {
  const samples: Sample[] = [];
  for (let i = lookback - 1; i + horizonMin < candles.length; i += stepMin) {
    const entry = candles[i];
    if (entry.openTime < startMs || entry.openTime > endMs) continue;
    const window = candles.slice(i - lookback + 1, i + 1).map((c) => c.close);
    const x = buildFeatureVector(window);
    if (!x) continue;
    const future = candles[i + horizonMin];
    const y = future.close > entry.close ? 1 : 0;
    samples.push({ timeMs: entry.openTime, x, y });
  }
  return samples;
}

function parseArgs(argv: string[]): { targetIds: string[]; allTargets: boolean } {
  const targetIds: string[] = [];
  let allTargets = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--all-targets") {
      allTargets = true;
      continue;
    }
    if (a === "--target" && i + 1 < argv.length) {
      targetIds.push(argv[i + 1]);
      i += 1;
      continue;
    }
  }
  return { targetIds, allTargets };
}

function getHorizonDefaults(horizonMin: SupportedHorizon): HorizonTrainingDefaults {
  if (horizonMin === 5) {
    return {
      lookbackMin: 180,
      stepMin: 1,
      valDays: 3,
      epochs: 500,
      learningRate: 0.04,
      l2: 0.001,
      patience: 60,
    };
  }
  if (horizonMin === 15) {
    return {
      lookbackMin: 240,
      stepMin: 3,
      valDays: 5,
      epochs: 420,
      learningRate: 0.03,
      l2: 0.0015,
      patience: 50,
    };
  }
  return {
    lookbackMin: 360,
    stepMin: 10,
    valDays: 7,
    epochs: 320,
    learningRate: 0.02,
    l2: 0.002,
    patience: 40,
  };
}

function buildGlobalBase(tc: TrainingConfig): HorizonTrainingDefaults {
  return {
    lookbackMin: Math.max(60, tc.lookbackMin),
    stepMin: Math.max(1, tc.stepMin),
    valDays: Math.max(1, tc.valDays),
    epochs: Math.max(10, tc.epochs),
    learningRate: Math.max(1e-5, tc.learningRate),
    l2: Math.max(0, tc.l2),
    patience: Math.max(5, tc.patience),
  };
}

function parseDateMs(value: string, label: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid date for ${label}: ${value}`);
  }
  return ms;
}

function resolveBaseTraining(tc: TrainingConfig, target: MarketTarget): { base: HorizonTrainingDefaults; profile: string } {
  const sameSymbol = (target.symbol || "").toUpperCase() === String(tc.symbol || "").toUpperCase();
  const sameHorizon = target.horizonMin === tc.horizonMin;
  if (sameSymbol && sameHorizon) {
    return { base: buildGlobalBase(tc), profile: "global_training" };
  }
  return { base: getHorizonDefaults(target.horizonMin), profile: `horizon_${target.horizonMin}m_default` };
}

function buildJobs(targetIdsArg: string[], allTargets: boolean): TrainJob[] {
  const cfg = loadConfig();
  const tc = cfg.training;

  const targets = allTargets || targetIdsArg.length ? cfg.targets : cfg.targets.filter((t) => t.enabled);
  const selected = targetIdsArg.length
    ? targets.filter((t) => targetIdsArg.includes(t.id))
    : targets;
  if (!selected.length) {
    throw new Error("No training targets selected");
  }
  if (targetIdsArg.length) {
    const selectedSet = new Set(selected.map((x) => x.id));
    const missing = targetIdsArg.filter((id) => !selectedSet.has(id));
    if (missing.length) {
      throw new Error(`Unknown target id(s): ${missing.join(", ")}`);
    }
  }

  return selected.map((t) => {
    const { base, profile } = resolveBaseTraining(tc, t);
    const symbol = (t.symbol || `${t.coin}USDT`).toUpperCase();
    const startRaw = t.trainStart ?? tc.start;
    const endRaw = t.trainEnd ?? tc.end;
    const startMs = parseDateMs(startRaw, `${t.id}.trainStart/training.start`);
    const endMs = parseDateMs(endRaw, `${t.id}.trainEnd/training.end`);
    if (startMs >= endMs) {
      throw new Error(`[${t.id}] training range invalid: start >= end (${startRaw} .. ${endRaw})`);
    }
    return {
      targetId: t.id,
      symbol,
      horizonMin: t.horizonMin,
      modelOut: t.modelPath || cfg.trainedModelPath,
      paramProfile: profile,
      lookback: Math.max(60, t.trainLookbackMin ?? t.lookbackMinutes ?? base.lookbackMin),
      stepMin: Math.max(1, t.trainStepMin ?? base.stepMin),
      valDays: Math.max(1, t.trainValDays ?? base.valDays),
      epochs: Math.max(10, t.trainEpochs ?? base.epochs),
      lr: Math.max(1e-5, t.trainLearningRate ?? base.learningRate),
      l2: Math.max(0, t.trainL2 ?? base.l2),
      patience: Math.max(5, t.trainPatience ?? base.patience),
      startMs,
      endMs,
    };
  });
}

async function runJob(job: TrainJob): Promise<void> {
  const fetchStart = job.startMs - (job.lookback + 5) * 60_000;
  const fetchEnd = job.endMs + (job.horizonMin + 2) * 60_000;

  console.log("[train] job", {
    targetId: job.targetId,
    symbol: job.symbol,
    horizonMin: job.horizonMin,
    paramProfile: job.paramProfile,
    lookback: job.lookback,
    stepMin: job.stepMin,
    start: new Date(job.startMs).toISOString(),
    end: new Date(job.endMs).toISOString(),
    valDays: job.valDays,
    epochs: job.epochs,
    lr: job.lr,
    l2: job.l2,
    patience: job.patience,
    modelOut: job.modelOut,
  });

  const candles = await fetchKlinesRange(job.symbol, fetchStart, fetchEnd);
  if (candles.length < job.lookback + job.horizonMin + 50) {
    throw new Error(`[${job.targetId}] not enough candles: ${candles.length}`);
  }

  const samples = buildSamples(candles, job.lookback, job.horizonMin, job.stepMin, job.startMs, job.endMs);
  if (samples.length < 200) {
    throw new Error(`[${job.targetId}] not enough training samples: ${samples.length}`);
  }

  const { train, val } = splitByTime(samples, job.valDays);
  if (train.length < 100) {
    throw new Error(`[${job.targetId}] train split too small: ${train.length}`);
  }

  const xTrainRaw = train.map((s) => s.x);
  const yTrain = train.map((s) => s.y);
  const xValRaw = val.map((s) => s.x);
  const yVal = val.map((s) => s.y);

  const { means, stds } = fitScaler(xTrainRaw);
  const xTrain = transform(xTrainRaw, means, stds);
  const xVal = transform(xValRaw, means, stds);

  const d = FEATURE_NAMES.length;
  let w = new Array(d).fill(0);
  let b = 0;

  let bestW = [...w];
  let bestB = b;
  let bestValLoss = Number.POSITIVE_INFINITY;
  let bestEpoch = 0;
  let stale = 0;

  for (let epoch = 1; epoch <= job.epochs; epoch += 1) {
    const preds = predictBatch(xTrain, w, b);
    const gradW = new Array(d).fill(0);
    let gradB = 0;

    for (let i = 0; i < xTrain.length; i += 1) {
      const err = preds[i] - yTrain[i];
      gradB += err;
      for (let j = 0; j < d; j += 1) gradW[j] += err * xTrain[i][j];
    }

    const invN = 1 / xTrain.length;
    gradB *= invN;
    for (let j = 0; j < d; j += 1) {
      gradW[j] = gradW[j] * invN + job.l2 * w[j];
      w[j] -= job.lr * gradW[j];
    }
    b -= job.lr * gradB;

    const valPreds = xVal.length ? predictBatch(xVal, w, b) : [];
    const valLoss = xVal.length ? computeLoss(valPreds, yVal, w, job.l2) : computeLoss(preds, yTrain, w, job.l2);

    if (valLoss + 1e-9 < bestValLoss) {
      bestValLoss = valLoss;
      bestW = [...w];
      bestB = b;
      bestEpoch = epoch;
      stale = 0;
    } else {
      stale += 1;
    }

    if (epoch % 50 === 0 || epoch === 1) {
      const trainLoss = computeLoss(preds, yTrain, w, job.l2);
      console.log(`[train][${job.targetId}] epoch=${epoch} trainLoss=${trainLoss.toFixed(6)} valLoss=${valLoss.toFixed(6)} stale=${stale}`);
    }

    if (stale >= job.patience) {
      console.log(`[train][${job.targetId}] early stop at epoch ${epoch}`);
      break;
    }
  }

  w = bestW;
  b = bestB;

  const trainPred = predictBatch(xTrain, w, b);
  const valPred = xVal.length ? predictBatch(xVal, w, b) : [];
  const trainMetrics = computeMetrics(trainPred, yTrain);
  const valMetrics = xVal.length ? computeMetrics(valPred, yVal) : trainMetrics;

  saveTrainedModel(job.modelOut, {
    modelType: "logreg_v1",
    symbol: job.symbol,
    horizonMin: job.horizonMin,
    trainedAt: new Date().toISOString(),
    featureNames: [...FEATURE_NAMES],
    means,
    stds,
    weights: w,
    bias: b,
    metrics: {
      train_accuracy: trainMetrics.accuracy,
      train_brier: trainMetrics.brier,
      train_log_loss: trainMetrics.logLoss,
      train_precision: trainMetrics.precision,
      train_recall: trainMetrics.recall,
      train_f1: trainMetrics.f1,
      val_accuracy: valMetrics.accuracy,
      val_brier: valMetrics.brier,
      val_log_loss: valMetrics.logLoss,
      val_precision: valMetrics.precision,
      val_recall: valMetrics.recall,
      val_f1: valMetrics.f1,
      best_epoch: bestEpoch,
    },
    trainRange: {
      start: new Date(job.startMs).toISOString(),
      end: new Date(job.endMs).toISOString(),
    },
  });

  console.log("[train] saved model", {
    targetId: job.targetId,
    modelOut: job.modelOut,
    symbol: job.symbol,
    horizonMin: job.horizonMin,
    metrics: {
      val_accuracy: Number(valMetrics.accuracy.toFixed(4)),
      val_brier: Number(valMetrics.brier.toFixed(6)),
      val_log_loss: Number(valMetrics.logLoss.toFixed(6)),
      val_f1: Number(valMetrics.f1.toFixed(4)),
      best_epoch: bestEpoch,
    },
  });
}

async function main(): Promise<void> {
  const { targetIds, allTargets } = parseArgs(process.argv.slice(2));
  const jobs = buildJobs(targetIds, allTargets);
  console.log("[train] targets", jobs.map((j) => j.targetId));

  const failed: Array<{ targetId: string; error: string }> = [];
  for (const job of jobs) {
    try {
      await runJob(job);
    } catch (err) {
      failed.push({
        targetId: job.targetId,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error("[train] failed", failed[failed.length - 1]);
    }
  }

  if (failed.length > 0) {
    throw new Error(`training finished with failures: ${JSON.stringify(failed)}`);
  }
}

main().catch((err) => {
  console.error("[train] fatal", err instanceof Error ? err.message : err);
  process.exit(1);
});
