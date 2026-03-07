import "dotenv/config";

import axios from "axios";

import { loadConfig } from "./config.js";
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
  if (samples.length < 50) {
    return { train: samples, val: [] };
  }

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
  if (!probs.length) {
    return { accuracy: 0, brier: 0, logLoss: 0, precision: 0, recall: 0, f1: 0 };
  }

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
      params: {
        symbol,
        interval: "1m",
        startTime: cursor,
        endTime: endMs,
        limit: 1000,
      },
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

    samples.push({
      timeMs: entry.openTime,
      x,
      y,
    });
  }

  return samples;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const tc = cfg.training;

  const symbol = tc.symbol;
  const horizonMin = Math.max(1, tc.horizonMin);
  const lookback = Math.max(60, tc.lookbackMin || cfg.lookbackMinutes);
  const stepMin = Math.max(1, tc.stepMin);
  const valDays = Math.max(1, tc.valDays);

  const epochs = Math.max(10, tc.epochs);
  const lr = Math.max(1e-5, tc.learningRate);
  const l2 = Math.max(0, tc.l2);
  const patience = Math.max(5, tc.patience);

  const endMs = Date.parse(tc.end);
  const startMs = Date.parse(tc.start);
  if (!Number.isFinite(endMs) || !Number.isFinite(startMs)) {
    throw new Error("Invalid training start/end datetime in config/runtime.json");
  }
  if (startMs >= endMs) throw new Error("TRAIN_START must be earlier than TRAIN_END");

  const modelOut = tc.modelOut || cfg.trainedModelPath;

  const fetchStart = startMs - (lookback + 5) * 60_000;
  const fetchEnd = endMs + (horizonMin + 2) * 60_000;

  console.log("[train] config", {
    symbol,
    horizonMin,
    lookback,
    stepMin,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    valDays,
    epochs,
    lr,
    l2,
    patience,
    modelOut,
  });

  const candles = await fetchKlinesRange(symbol, fetchStart, fetchEnd);
  if (candles.length < lookback + horizonMin + 50) {
    throw new Error(`Not enough candles for training: ${candles.length}`);
  }

  const samples = buildSamples(candles, lookback, horizonMin, stepMin, startMs, endMs);
  if (samples.length < 200) {
    throw new Error(`Not enough training samples: ${samples.length}`);
  }

  const { train, val } = splitByTime(samples, valDays);
  if (train.length < 100) {
    throw new Error(`Train split too small: ${train.length}`);
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

  for (let epoch = 1; epoch <= epochs; epoch += 1) {
    const preds = predictBatch(xTrain, w, b);

    const gradW = new Array(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < xTrain.length; i += 1) {
      const err = preds[i] - yTrain[i];
      gradB += err;
      for (let j = 0; j < d; j += 1) {
        gradW[j] += err * xTrain[i][j];
      }
    }

    const invN = 1 / xTrain.length;
    gradB *= invN;
    for (let j = 0; j < d; j += 1) {
      gradW[j] = gradW[j] * invN + l2 * w[j];
    }

    for (let j = 0; j < d; j += 1) {
      w[j] -= lr * gradW[j];
    }
    b -= lr * gradB;

    const valPreds = xVal.length ? predictBatch(xVal, w, b) : [];
    const valLoss = xVal.length ? computeLoss(valPreds, yVal, w, l2) : computeLoss(preds, yTrain, w, l2);

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
      const trainLoss = computeLoss(preds, yTrain, w, l2);
      console.log(`[train] epoch=${epoch} trainLoss=${trainLoss.toFixed(6)} valLoss=${valLoss.toFixed(6)} stale=${stale}`);
    }

    if (stale >= patience) {
      console.log(`[train] early stop at epoch ${epoch}`);
      break;
    }
  }

  w = bestW;
  b = bestB;

  const trainPred = predictBatch(xTrain, w, b);
  const valPred = xVal.length ? predictBatch(xVal, w, b) : [];

  const trainMetrics = computeMetrics(trainPred, yTrain);
  const valMetrics = xVal.length ? computeMetrics(valPred, yVal) : trainMetrics;

  const artifact = {
    modelType: "logreg_v1" as const,
    symbol,
    horizonMin,
    trainedAt: new Date().toISOString(),
    featureNames: [...FEATURE_NAMES],
    means,
    stds,
    weights: w,
    bias: b,
    metrics: {
      bestEpoch,
      bestValLoss,
      trainAccuracy: trainMetrics.accuracy,
      trainBrier: trainMetrics.brier,
      trainLogLoss: trainMetrics.logLoss,
      valAccuracy: valMetrics.accuracy,
      valBrier: valMetrics.brier,
      valLogLoss: valMetrics.logLoss,
      valPrecision: valMetrics.precision,
      valRecall: valMetrics.recall,
      valF1: valMetrics.f1,
      trainSize: train.length,
      valSize: val.length,
      totalSize: samples.length,
    },
    trainRange: {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
    },
  };

  saveTrainedModel(modelOut, artifact);

  console.log("\n[train] done");
  console.log({
    modelOut,
    bestEpoch,
    bestValLoss,
    trainSize: train.length,
    valSize: val.length,
    trainMetrics,
    valMetrics,
  });
}

main().catch((err) => {
  console.error("[train] fatal", err instanceof Error ? err.message : err);
  process.exit(1);
});
