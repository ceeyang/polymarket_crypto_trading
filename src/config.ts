import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

export const MAX_TARGETS = 12;
export const SUPPORTED_COINS = ["BTC", "ETH", "SOL", "XRP"] as const;
export const SUPPORTED_HORIZONS = [5, 15, 60] as const;

export type SupportedCoin = (typeof SUPPORTED_COINS)[number];
export type SupportedHorizon = (typeof SUPPORTED_HORIZONS)[number];

export interface TrainingConfig {
  symbol: string;
  start: string;
  end: string;
  horizonMin: number;
  lookbackMin: number;
  stepMin: number;
  valDays: number;
  epochs: number;
  learningRate: number;
  l2: number;
  patience: number;
  modelOut: string;
}

export interface MarketTarget {
  id: string;
  enabled: boolean;
  coin: SupportedCoin;
  horizonMin: SupportedHorizon;
  symbol: string;
  modelPath?: string;
  lookbackMinutes?: number;
  minEdge?: number;
  baseBetUsd?: number;
  maxBetUsd?: number;
  minOrderShares?: number;
  priceAggression?: number;
  trainStart?: string;
  trainEnd?: string;
  trainLookbackMin?: number;
  trainStepMin?: number;
  trainValDays?: number;
  trainEpochs?: number;
  trainLearningRate?: number;
  trainL2?: number;
  trainPatience?: number;
}

export interface RuntimeConfigFile {
  runtime: {
    dryRun: boolean;
    pollIntervalSec: number;
    autoClaim?: boolean;
    claimCooldownSec?: number;
    maxDrawdownPct?: number;
    maxOpenTrades?: number;
    maxTradesPerDay?: number;
    maxConsecutiveLosses?: number;
  };
  prediction: {
    lookbackMinutes: number;
    trainedModelPath: string;
    minEdge: number;
    baseBetUsd: number;
    maxBetUsd: number;
    minOrderShares?: number;
    priceAggression: number;
    minEntryPrice?: number;
    maxEntryPrice?: number;
    minOverround?: number;
    maxOverround?: number;
    enableReverseFallback?: boolean;
    reverseMinEntrySeconds?: number;
    reverseMinModelProb?: number;
    reverseMinEdgeMultiplier?: number;
    targets?: Partial<MarketTarget>[];
  };
  marketFilter: {
    minMarketLiquidity: number;
    minTimeToExpiryMin: number;
    maxTimeToExpiryMin: number;
    cooldownSeconds: number;
    minEntrySeconds?: number;
  };
  network: {
    polyHost: string;
    gammaHost: string;
    dataApiHost: string;
    rpcUrl: string;
    rpcUrls?: string[];
    relayerHost?: string;
    relayerTxType?: string;
    chainId: number;
    signatureType: number;
    usdcAddress: string;
    ctfAddress: string;
  };
  training: TrainingConfig;
}

export interface Config {
  dryRun: boolean;
  pollIntervalSec: number;
  autoClaim: boolean;
  claimCooldownSec: number;
  maxDrawdownPct: number;
  maxOpenTrades: number;
  maxTradesPerDay: number;
  maxConsecutiveLosses: number;
  lookbackMinutes: number;
  trainedModelPath: string;
  minEdge: number;
  baseBetUsd: number;
  maxBetUsd: number;
  minOrderShares: number;
  priceAggression: number;
  minEntryPrice: number;
  maxEntryPrice: number;
  minOverround: number;
  maxOverround: number;
  enableReverseFallback: boolean;
  reverseMinEntrySeconds: number;
  reverseMinModelProb: number;
  reverseMinEdgeMultiplier: number;
  minMarketLiquidity: number;
  minTimeToExpiryMin: number;
  maxTimeToExpiryMin: number;
  cooldownSeconds: number;
  minEntrySeconds: number;
  polyHost: string;
  gammaHost: string;
  dataApiHost: string;
  rpcUrl: string;
  rpcUrls: string[];
  relayerHost: string;
  relayerTxType: "SAFE" | "PROXY";
  chainId: number;
  signatureType: number;
  usdcAddress: string;
  ctfAddress: string;
  targets: MarketTarget[];
  privateKey: string;
  funderAddress?: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  builderApiKey?: string;
  builderSecret?: string;
  builderPassphrase?: string;
  training: TrainingConfig;
}

const RUNTIME_CONFIG_PATH = path.resolve("config", "runtime.json");

export function getTargetId(coin: SupportedCoin, horizonMin: SupportedHorizon): string {
  const tag = horizonMin === 60 ? "1h" : `${horizonMin}m`;
  return `${coin}_${tag}`;
}

export function getDefaultModelPathForTarget(coin: SupportedCoin, horizonMin: SupportedHorizon): string {
  const h = horizonMin === 60 ? "1h" : `${horizonMin}m`;
  return `state/models/${coin.toLowerCase()}_${h}_logreg.json`;
}

function parseSignatureType(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (n === 0 || n === 1 || n === 2) return n;
  return fallback;
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseNonNegativeInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function parsePositiveNumber(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseNonNegativeNumber(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function normalizeRelayerTxType(raw: string | undefined): "SAFE" | "PROXY" | null {
  if (!raw) return null;
  const v = raw.trim().toUpperCase();
  if (v === "SAFE" || v === "2") return "SAFE";
  if (v === "PROXY" || v === "0" || v === "1") return "PROXY";
  return null;
}

function normalizeCoin(raw: unknown, fallback: SupportedCoin): SupportedCoin {
  const v = String(raw ?? "").trim().toUpperCase();
  return (SUPPORTED_COINS as readonly string[]).includes(v) ? (v as SupportedCoin) : fallback;
}

function normalizeHorizon(raw: unknown, fallback: SupportedHorizon): SupportedHorizon {
  const n = Number(raw);
  if ((SUPPORTED_HORIZONS as readonly number[]).includes(n)) return n as SupportedHorizon;
  return fallback;
}

function buildDefaultTargets(defaultModelPath: string): MarketTarget[] {
  const targets: MarketTarget[] = [];
  for (const coin of SUPPORTED_COINS) {
    for (const horizonMin of SUPPORTED_HORIZONS) {
      const enabled = horizonMin === 5 && (coin === "BTC" || coin === "ETH");
      targets.push({
        id: getTargetId(coin, horizonMin),
        enabled,
        coin,
        horizonMin,
        symbol: `${coin}USDT`,
        modelPath: getDefaultModelPathForTarget(coin, horizonMin) || defaultModelPath,
      });
    }
  }
  return targets;
}

function normalizeTargets(rawTargets: Partial<MarketTarget>[] | undefined, defaultModelPath: string): MarketTarget[] {
  const defaults = buildDefaultTargets(defaultModelPath);
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) return defaults;

  const out: MarketTarget[] = [];
  for (let i = 0; i < rawTargets.length && out.length < MAX_TARGETS; i += 1) {
    const t = rawTargets[i] ?? {};
    const coin = normalizeCoin(t.coin, "BTC");
    const horizonMin = normalizeHorizon(t.horizonMin, 5);
    out.push({
      id: typeof t.id === "string" && t.id.trim() ? t.id.trim() : getTargetId(coin, horizonMin),
      enabled: Boolean(t.enabled),
      coin,
      horizonMin,
      symbol: typeof t.symbol === "string" && t.symbol.trim() ? t.symbol.trim().toUpperCase() : `${coin}USDT`,
      modelPath: typeof t.modelPath === "string" && t.modelPath.trim()
        ? t.modelPath.trim()
        : getDefaultModelPathForTarget(coin, horizonMin) || defaultModelPath,
      lookbackMinutes: t.lookbackMinutes == null ? undefined : parsePositiveInt(t.lookbackMinutes, 120),
      minEdge: t.minEdge == null ? undefined : parsePositiveNumber(t.minEdge, 0.02),
      baseBetUsd: t.baseBetUsd == null ? undefined : parsePositiveNumber(t.baseBetUsd, 1.5),
      maxBetUsd: t.maxBetUsd == null ? undefined : parsePositiveNumber(t.maxBetUsd, 2.6),
      minOrderShares: t.minOrderShares == null ? undefined : parsePositiveNumber(t.minOrderShares, 5),
      priceAggression: t.priceAggression == null ? undefined : parsePositiveNumber(t.priceAggression, 0.01),
      trainStart: typeof t.trainStart === "string" && t.trainStart.trim() ? t.trainStart.trim() : undefined,
      trainEnd: typeof t.trainEnd === "string" && t.trainEnd.trim() ? t.trainEnd.trim() : undefined,
      trainLookbackMin: t.trainLookbackMin == null ? undefined : parsePositiveInt(t.trainLookbackMin, 120),
      trainStepMin: t.trainStepMin == null ? undefined : parsePositiveInt(t.trainStepMin, 1),
      trainValDays: t.trainValDays == null ? undefined : parsePositiveInt(t.trainValDays, 3),
      trainEpochs: t.trainEpochs == null ? undefined : parsePositiveInt(t.trainEpochs, 400),
      trainLearningRate: t.trainLearningRate == null ? undefined : parsePositiveNumber(t.trainLearningRate, 0.05),
      trainL2: t.trainL2 == null ? undefined : parseNonNegativeNumber(t.trainL2, 0.001),
      trainPatience: t.trainPatience == null ? undefined : parsePositiveInt(t.trainPatience, 40),
    });
  }

  return out.length > 0 ? out : defaults;
}

export function readRuntimeConfig(): RuntimeConfigFile {
  if (!fs.existsSync(RUNTIME_CONFIG_PATH)) {
    throw new Error(`Missing runtime config file: ${RUNTIME_CONFIG_PATH}`);
  }
  const raw = fs.readFileSync(RUNTIME_CONFIG_PATH, "utf8");
  return JSON.parse(raw) as RuntimeConfigFile;
}

export function writeRuntimeConfig(next: RuntimeConfigFile): void {
  const dir = path.dirname(RUNTIME_CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
}

export function loadConfig(): Config {
  const rc = readRuntimeConfig();
  const rpcUrls = Array.from(new Set([
    ...(Array.isArray(rc.network.rpcUrls) ? rc.network.rpcUrls : []),
    rc.network.rpcUrl,
  ].map((x) => String(x || "").trim()).filter(Boolean)));
  const signatureType = parseSignatureType(
    process.env.SIGNATURE_TYPE ?? process.env.POLY_SIGNATURE_TYPE,
    rc.network.signatureType ?? 2,
  );
  const relayerTxTypeFromEnv = normalizeRelayerTxType(process.env.RELAYER_TX_TYPE);
  const relayerTxTypeFromRuntime = normalizeRelayerTxType(rc.network.relayerTxType);
  const relayerTxType = relayerTxTypeFromEnv
    ?? relayerTxTypeFromRuntime
    ?? (signatureType === 2 ? "SAFE" : "PROXY");
  const autoClaim = rc.runtime.autoClaim ?? true;
  const claimCooldownSec = parsePositiveInt(rc.runtime.claimCooldownSec, 300);
  const maxDrawdownPct = parseNonNegativeNumber(rc.runtime.maxDrawdownPct, 0);
  const maxOpenTrades = parseNonNegativeInt(rc.runtime.maxOpenTrades, 6);
  const maxTradesPerDay = parseNonNegativeInt(rc.runtime.maxTradesPerDay, 120);
  const maxConsecutiveLosses = parseNonNegativeInt(rc.runtime.maxConsecutiveLosses, 4);
  const minOrderShares = parsePositiveNumber(rc.prediction.minOrderShares, 5);
  const minEntryPrice = parsePositiveNumber(rc.prediction.minEntryPrice, 0.05);
  const maxEntryPrice = parsePositiveNumber(rc.prediction.maxEntryPrice, 0.90);
  const minOverround = parsePositiveNumber(rc.prediction.minOverround, 0.95);
  const maxOverround = parsePositiveNumber(rc.prediction.maxOverround, 1.06);
  const enableReverseFallback = Boolean(rc.prediction.enableReverseFallback ?? false);
  const reverseMinEntrySeconds = parsePositiveInt(rc.prediction.reverseMinEntrySeconds, 90);
  const reverseMinModelProbRaw = parseNonNegativeNumber(rc.prediction.reverseMinModelProb, 0.42);
  const reverseMinEdgeMultiplier = parsePositiveNumber(rc.prediction.reverseMinEdgeMultiplier, 1.3);
  const reverseMinModelProb = Math.max(0, Math.min(1, reverseMinModelProbRaw));
  const minEntrySeconds = parsePositiveInt(rc.marketFilter.minEntrySeconds, 45);
  const targets = normalizeTargets(rc.prediction.targets, rc.prediction.trainedModelPath);

  return {
    dryRun: rc.runtime.dryRun,
    pollIntervalSec: rc.runtime.pollIntervalSec,
    autoClaim,
    claimCooldownSec,
    maxDrawdownPct,
    maxOpenTrades,
    maxTradesPerDay,
    maxConsecutiveLosses,
    lookbackMinutes: rc.prediction.lookbackMinutes,
    trainedModelPath: rc.prediction.trainedModelPath,
    minEdge: rc.prediction.minEdge,
    baseBetUsd: rc.prediction.baseBetUsd,
    maxBetUsd: rc.prediction.maxBetUsd,
    minOrderShares,
    priceAggression: rc.prediction.priceAggression,
    minEntryPrice: Math.min(minEntryPrice, maxEntryPrice),
    maxEntryPrice: Math.max(minEntryPrice, maxEntryPrice),
    minOverround: Math.min(minOverround, maxOverround),
    maxOverround: Math.max(minOverround, maxOverround),
    enableReverseFallback,
    reverseMinEntrySeconds,
    reverseMinModelProb,
    reverseMinEdgeMultiplier,
    minMarketLiquidity: rc.marketFilter.minMarketLiquidity,
    minTimeToExpiryMin: rc.marketFilter.minTimeToExpiryMin,
    maxTimeToExpiryMin: rc.marketFilter.maxTimeToExpiryMin,
    cooldownSeconds: rc.marketFilter.cooldownSeconds,
    minEntrySeconds,
    polyHost: rc.network.polyHost,
    gammaHost: rc.network.gammaHost,
    dataApiHost: rc.network.dataApiHost,
    rpcUrl: rpcUrls[0],
    rpcUrls,
    relayerHost: String(rc.network.relayerHost || "https://relayer-v2.polymarket.com"),
    relayerTxType,
    chainId: rc.network.chainId,
    signatureType,
    usdcAddress: rc.network.usdcAddress,
    ctfAddress: rc.network.ctfAddress,
    targets,
    privateKey: process.env.PRIVATE_KEY ?? "",
    funderAddress: process.env.FUNDER_ADDRESS,
    apiKey: process.env.POLY_API_KEY,
    apiSecret: process.env.POLY_API_SECRET,
    apiPassphrase: process.env.POLY_API_PASSPHRASE,
    builderApiKey: process.env.POLY_BUILDER_API_KEY ?? process.env.BUILDER_API_KEY,
    builderSecret: process.env.POLY_BUILDER_SECRET ?? process.env.BUILDER_SECRET,
    builderPassphrase: process.env.POLY_BUILDER_PASSPHRASE ?? process.env.BUILDER_PASSPHRASE ?? process.env.BUILDER_PASS_PHRASE,
    training: rc.training,
  };
}
