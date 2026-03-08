import fs from "node:fs";
import path from "node:path";

import type { Config, MarketTarget, SupportedHorizon } from "../config.js";
import { BinanceClient } from "../clients/binance.js";
import { FEATURE_NAMES, buildFeatureVector } from "../strategy/features.js";
import { saveTrainedModel, type TrainedModelArtifact } from "../strategy/trained-model.js";

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

export interface ModelProfile {
  id: string;
  name: string;
  targetId: string;
  coin: string;
  horizonMin: number;
  symbol: string;
  trainDays: number;
  lookbackMin: number;
  stepMin: number;
  valDays: number;
  epochs: number;
  learningRate: number;
  l2: number;
  patience: number;
  modelPath: string;
  status: "idle" | "training" | "ready" | "error";
  updatedAt: string;
  lastTrainedAt?: string;
  lastError?: string;
  metrics?: Record<string, number>;
}

interface ProfileStateFile {
  profiles: ModelProfile[];
}

const PROFILE_FILE = path.resolve("state", "model-profiles.json");
const DAY_MS = 24 * 60 * 60 * 1000;

function isoNow(): string {
  return new Date().toISOString();
}

function horizonTag(h: number): string {
  return h === 60 ? "1h" : `${h}m`;
}

function parseNum(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
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

function predictBatch(xs: number[][], w: number[], b: number): number[] {
  return xs.map((x) => sigmoid(dot(x, w) + b));
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
    brier += (p - y) * (p - y);
    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    if (pred === 1 && y === 1) tp += 1;
    if (pred === 1 && y === 0) fp += 1;
    if (pred === 0 && y === 1) fn += 1;
  }
  const acc = correct / probs.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    accuracy: acc,
    brier: brier / probs.length,
    logLoss: logLoss / probs.length,
    precision,
    recall,
    f1,
  };
}

function splitByTime(samples: Sample[], valDays: number): { train: Sample[]; val: Sample[] } {
  if (samples.length < 50) return { train: samples, val: [] };
  const valMs = Math.max(1, valDays) * DAY_MS;
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

function defaultTrainDays(horizonMin: number): number {
  if (horizonMin === 5) return 21;
  if (horizonMin === 15) return 45;
  return 90;
}

function defaultLookback(horizonMin: number): number {
  if (horizonMin === 5) return 180;
  if (horizonMin === 15) return 240;
  return 360;
}

function defaultStep(horizonMin: number): number {
  if (horizonMin === 5) return 1;
  if (horizonMin === 15) return 3;
  return 10;
}

function defaultValDays(horizonMin: number): number {
  if (horizonMin === 5) return 3;
  if (horizonMin === 15) return 5;
  return 7;
}

function defaultEpochs(horizonMin: number): number {
  if (horizonMin === 5) return 500;
  if (horizonMin === 15) return 420;
  return 320;
}

function defaultLr(horizonMin: number): number {
  if (horizonMin === 5) return 0.04;
  if (horizonMin === 15) return 0.03;
  return 0.02;
}

function defaultL2(horizonMin: number): number {
  if (horizonMin === 5) return 0.001;
  if (horizonMin === 15) return 0.0015;
  return 0.002;
}

function defaultPatience(horizonMin: number): number {
  if (horizonMin === 5) return 60;
  if (horizonMin === 15) return 50;
  return 40;
}

function loadState(): ProfileStateFile {
  try {
    if (!fs.existsSync(PROFILE_FILE)) return { profiles: [] };
    const raw = fs.readFileSync(PROFILE_FILE, "utf8");
    const parsed = JSON.parse(raw) as ProfileStateFile;
    if (!Array.isArray(parsed?.profiles)) return { profiles: [] };
    return { profiles: parsed.profiles };
  } catch {
    return { profiles: [] };
  }
}

function saveState(state: ProfileStateFile): void {
  fs.mkdirSync(path.dirname(PROFILE_FILE), { recursive: true });
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function createProfileFromTarget(t: MarketTarget): ModelProfile {
  const tag = horizonTag(t.horizonMin);
  const trainDays = defaultTrainDays(t.horizonMin);
  return {
    id: `${t.id}_d${trainDays}`,
    name: `${t.coin}_${tag}_d${trainDays}`,
    targetId: t.id,
    coin: t.coin,
    horizonMin: t.horizonMin,
    symbol: (t.symbol || `${t.coin}USDT`).toUpperCase(),
    trainDays,
    lookbackMin: defaultLookback(t.horizonMin),
    stepMin: defaultStep(t.horizonMin),
    valDays: defaultValDays(t.horizonMin),
    epochs: defaultEpochs(t.horizonMin),
    learningRate: defaultLr(t.horizonMin),
    l2: defaultL2(t.horizonMin),
    patience: defaultPatience(t.horizonMin),
    modelPath: `state/models/${t.coin.toLowerCase()}_${tag}_d${trainDays}_logreg.json`,
    status: "idle",
    updatedAt: isoNow(),
  };
}

export function ensureDefaultProfiles(cfg: Config): ModelProfile[] {
  const state = loadState();
  const byId = new Map(state.profiles.map((p) => [p.id, p]));
  let changed = false;
  for (const t of cfg.targets) {
    if (![5, 15, 60].includes(Number(t.horizonMin))) continue;
    const d = createProfileFromTarget(t);
    const hasDefaultForTarget = state.profiles.some((p) => {
      if (p.targetId !== t.id) return false;
      return p.id.startsWith(`${t.id}_d`);
    });
    if (hasDefaultForTarget) continue;
    if (!byId.has(d.id)) {
      byId.set(d.id, d);
      changed = true;
    }
  }
  const profiles = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (changed || state.profiles.length !== profiles.length) {
    saveState({ profiles });
  }
  return profiles;
}

export function listProfiles(cfg: Config): ModelProfile[] {
  ensureDefaultProfiles(cfg);
  return loadState().profiles.sort((a, b) => a.name.localeCompare(b.name));
}

export function upsertProfile(cfg: Config, raw: Partial<ModelProfile> & { targetId: string; name?: string }): ModelProfile {
  const target = cfg.targets.find((t) => t.id === raw.targetId);
  if (!target) throw new Error(`target not found: ${raw.targetId}`);
  const state = loadState();
  const id = (raw.id && String(raw.id).trim()) || `${raw.targetId}_custom_${Date.now()}`;
  const prev = state.profiles.find((p) => p.id === id);
  const horizonMin = Number(target.horizonMin) as SupportedHorizon;
  const tag = horizonTag(horizonMin);
  const trainDays = Math.max(1, Math.floor(parseNum(raw.trainDays, prev?.trainDays ?? defaultTrainDays(horizonMin))));
  const profile: ModelProfile = {
    id,
    name: String(raw.name || prev?.name || `${target.coin}_${tag}_d${trainDays}`).trim(),
    targetId: target.id,
    coin: target.coin,
    horizonMin,
    symbol: (target.symbol || `${target.coin}USDT`).toUpperCase(),
    trainDays,
    lookbackMin: Math.max(60, Math.floor(parseNum(raw.lookbackMin, prev?.lookbackMin ?? defaultLookback(horizonMin)))),
    stepMin: Math.max(1, Math.floor(parseNum(raw.stepMin, prev?.stepMin ?? defaultStep(horizonMin)))),
    valDays: Math.max(1, Math.floor(parseNum(raw.valDays, prev?.valDays ?? defaultValDays(horizonMin)))),
    epochs: Math.max(20, Math.floor(parseNum(raw.epochs, prev?.epochs ?? defaultEpochs(horizonMin)))),
    learningRate: Math.max(1e-5, parseNum(raw.learningRate, prev?.learningRate ?? defaultLr(horizonMin))),
    l2: Math.max(0, parseNum(raw.l2, prev?.l2 ?? defaultL2(horizonMin))),
    patience: Math.max(5, Math.floor(parseNum(raw.patience, prev?.patience ?? defaultPatience(horizonMin)))),
    modelPath: String(raw.modelPath || prev?.modelPath || `state/models/${target.coin.toLowerCase()}_${tag}_custom_logreg.json`).trim(),
    status: prev?.status ?? "idle",
    updatedAt: isoNow(),
    lastTrainedAt: prev?.lastTrainedAt,
    lastError: prev?.lastError,
    metrics: prev?.metrics,
  };

  const next = state.profiles.filter((p) => p.id !== id);
  next.push(profile);
  saveState({ profiles: next.sort((a, b) => a.name.localeCompare(b.name)) });
  return profile;
}

export function deleteProfile(
  cfg: Config,
  profileId: string,
  options?: { deleteModelFile?: boolean },
): {
  deletedProfile: ModelProfile;
  modelFileDeleted: boolean;
  modelFilePath: string;
} {
  ensureDefaultProfiles(cfg);
  const state = loadState();
  const idx = state.profiles.findIndex((p) => p.id === profileId);
  if (idx < 0) {
    throw new Error(`profile not found: ${profileId}`);
  }
  const [deletedProfile] = state.profiles.splice(idx, 1);
  saveState({ profiles: state.profiles.sort((a, b) => a.name.localeCompare(b.name)) });

  const modelFilePath = path.resolve(String(deletedProfile.modelPath || "").trim());
  let modelFileDeleted = false;
  if (options?.deleteModelFile && deletedProfile.modelPath) {
    try {
      if (fs.existsSync(modelFilePath)) {
        fs.unlinkSync(modelFilePath);
        modelFileDeleted = true;
      }
    } catch {
      // best effort
    }
  }

  return {
    deletedProfile,
    modelFileDeleted,
    modelFilePath,
  };
}

function markProfile(id: string, patch: Partial<ModelProfile>): ModelProfile {
  const state = loadState();
  const idx = state.profiles.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error(`profile not found: ${id}`);
  const next: ModelProfile = {
    ...state.profiles[idx],
    ...patch,
    updatedAt: isoNow(),
  };
  state.profiles[idx] = next;
  saveState(state);
  return next;
}

function buildAlignedSamples(candles: Candle[], lookback: number, horizonMin: number, stepMin: number, startMs: number, endMs: number): Sample[] {
  const minuteMs = 60_000;
  const horizonMs = Math.max(1, horizonMin) * minuteMs;
  const timeStepMin = Math.max(1, Math.floor(stepMin));
  const endAlignedMs = Math.floor(endMs / horizonMs) * horizonMs;
  const rowByTime = new Map<number, Candle>();
  const idxByTime = new Map<number, number>();
  for (let i = 0; i < candles.length; i += 1) {
    rowByTime.set(candles[i].openTime, candles[i]);
    idxByTime.set(candles[i].openTime, i);
  }
  const gapPrefix = new Array(candles.length + 1).fill(0);
  for (let i = 1; i < candles.length; i += 1) {
    const gap = candles[i].openTime - candles[i - 1].openTime !== minuteMs ? 1 : 0;
    gapPrefix[i + 1] = gapPrefix[i] + gap;
  }
  const isContinuous = (startIdx: number, endIdx: number): boolean => {
    if (startIdx < 0 || endIdx <= startIdx) return false;
    return gapPrefix[endIdx + 1] - gapPrefix[startIdx + 1] === 0;
  };

  const samples: Sample[] = [];
  for (let i = lookback - 1; i + horizonMin < candles.length; i += 1) {
    const entry = candles[i];
    if (entry.openTime < startMs || entry.openTime > endAlignedMs) continue;
    if (entry.openTime % horizonMs !== 0) continue;
    if ((Math.floor(entry.openTime / minuteMs) % timeStepMin) !== 0) continue;
    const futureTime = entry.openTime + horizonMs;
    const future = rowByTime.get(futureTime);
    const futureIdx = idxByTime.get(futureTime);
    if (!future || futureIdx == null) continue;
    const startIdx = i - lookback + 1;
    if (!isContinuous(startIdx, i)) continue;
    if (!isContinuous(i, futureIdx)) continue;

    const window = candles.slice(startIdx, i + 1).map((c) => c.close);
    const x = buildFeatureVector(window);
    if (!x) continue;
    const y = future.close >= entry.close ? 1 : 0;
    samples.push({ timeMs: entry.openTime, x, y });
  }
  return samples;
}

export async function trainProfile(cfg: Config, profileId: string): Promise<ModelProfile> {
  const profiles = listProfiles(cfg);
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error(`profile not found: ${profileId}`);

  markProfile(profileId, { status: "training", lastError: undefined });

  try {
    const horizonMin = Math.max(1, Math.floor(profile.horizonMin));
    const nowMs = Date.now();
    const endMs = Math.floor(nowMs / (horizonMin * 60_000)) * (horizonMin * 60_000);
    const startMs = endMs - profile.trainDays * DAY_MS;
    if (startMs >= endMs) throw new Error("invalid train range");

    const fetchStart = startMs - (profile.lookbackMin + 5) * 60_000;
    const fetchEnd = endMs + (horizonMin + 2) * 60_000;
    const binance = new BinanceClient();
    const rows = await binance.getCloseSeries(profile.symbol, "1m", fetchStart, fetchEnd, 180);
    const candles = rows.map((r) => ({ openTime: r.openTime, close: r.close }));

    if (candles.length < profile.lookbackMin + horizonMin + 50) {
      throw new Error(`not enough candles: ${candles.length}`);
    }

    const samples = buildAlignedSamples(candles, profile.lookbackMin, horizonMin, profile.stepMin, startMs, endMs);
    if (samples.length < 200) {
      throw new Error(`not enough training samples: ${samples.length}`);
    }

    const { train, val } = splitByTime(samples, profile.valDays);
    if (train.length < 100) {
      throw new Error(`train split too small: ${train.length}`);
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

    for (let epoch = 1; epoch <= profile.epochs; epoch += 1) {
      const preds = predictBatch(xTrain, w, b);
      const gradW = new Array(d).fill(0);
      let gradB = 0;
      for (let i = 0; i < xTrain.length; i += 1) {
        const e = preds[i] - yTrain[i];
        for (let j = 0; j < d; j += 1) gradW[j] += e * xTrain[i][j];
        gradB += e;
      }
      for (let j = 0; j < d; j += 1) {
        gradW[j] = gradW[j] / xTrain.length + 2 * profile.l2 * w[j];
      }
      gradB /= xTrain.length;

      for (let j = 0; j < d; j += 1) w[j] -= profile.learningRate * gradW[j];
      b -= profile.learningRate * gradB;

      const valPred = xVal.length ? predictBatch(xVal, w, b) : [];
      const valLoss = valPred.length
        ? computeMetrics(valPred, yVal).logLoss + profile.l2 * w.reduce((acc, wi) => acc + wi * wi, 0)
        : Number.POSITIVE_INFINITY;
      if (valLoss + 1e-8 < bestValLoss) {
        bestValLoss = valLoss;
        bestW = [...w];
        bestB = b;
        bestEpoch = epoch;
        stale = 0;
      } else {
        stale += 1;
      }
      if (stale >= profile.patience) break;
    }

    const trainPred = predictBatch(xTrain, bestW, bestB);
    const valPred = xVal.length ? predictBatch(xVal, bestW, bestB) : [];
    const trainM = computeMetrics(trainPred, yTrain);
    const valM = valPred.length ? computeMetrics(valPred, yVal) : { accuracy: 0, brier: 0, logLoss: 0, precision: 0, recall: 0, f1: 0 };
    const metrics = {
      train_accuracy: trainM.accuracy,
      train_brier: trainM.brier,
      train_log_loss: trainM.logLoss,
      train_precision: trainM.precision,
      train_recall: trainM.recall,
      train_f1: trainM.f1,
      val_accuracy: valM.accuracy,
      val_brier: valM.brier,
      val_log_loss: valM.logLoss,
      val_precision: valM.precision,
      val_recall: valM.recall,
      val_f1: valM.f1,
      best_epoch: bestEpoch,
      sample_count: samples.length,
      train_count: train.length,
      val_count: val.length,
    };

    const artifact: TrainedModelArtifact = {
      modelType: "logreg_v1",
      symbol: profile.symbol,
      horizonMin,
      trainedAt: isoNow(),
      featureNames: [...FEATURE_NAMES],
      means,
      stds,
      weights: bestW,
      bias: bestB,
      metrics,
      trainRange: {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
      },
    };
    saveTrainedModel(profile.modelPath, artifact);

    return markProfile(profileId, {
      status: "ready",
      lastError: undefined,
      lastTrainedAt: isoNow(),
      metrics,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markProfile(profileId, { status: "error", lastError: msg });
    throw err;
  }
}
