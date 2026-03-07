import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

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

export interface Config {
  dryRun: boolean;
  pollIntervalSec: number;
  lookbackMinutes: number;
  trainedModelPath: string;
  minEdge: number;
  baseBetUsd: number;
  maxBetUsd: number;
  priceAggression: number;
  minMarketLiquidity: number;
  minTimeToExpiryMin: number;
  maxTimeToExpiryMin: number;
  cooldownSeconds: number;
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

interface RuntimeFile {
  runtime: {
    dryRun: boolean;
    pollIntervalSec: number;
  };
  prediction: {
    lookbackMinutes: number;
    trainedModelPath: string;
    minEdge: number;
    baseBetUsd: number;
    maxBetUsd: number;
    priceAggression: number;
  };
  marketFilter: {
    minMarketLiquidity: number;
    minTimeToExpiryMin: number;
    maxTimeToExpiryMin: number;
    cooldownSeconds: number;
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

function parseSignatureType(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (n === 0 || n === 1 || n === 2) return n;
  return fallback;
}

function normalizeRelayerTxType(raw: string | undefined): "SAFE" | "PROXY" | null {
  if (!raw) return null;
  const v = raw.trim().toUpperCase();
  if (v === "SAFE" || v === "2") return "SAFE";
  if (v === "PROXY" || v === "0" || v === "1") return "PROXY";
  return null;
}

function loadRuntimeFile(): RuntimeFile {
  const filePath = path.resolve("config", "runtime.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing runtime config file: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as RuntimeFile;
  return parsed;
}

export function loadConfig(): Config {
  const rc = loadRuntimeFile();
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

  return {
    dryRun: rc.runtime.dryRun,
    pollIntervalSec: rc.runtime.pollIntervalSec,
    lookbackMinutes: rc.prediction.lookbackMinutes,
    trainedModelPath: rc.prediction.trainedModelPath,
    minEdge: rc.prediction.minEdge,
    baseBetUsd: rc.prediction.baseBetUsd,
    maxBetUsd: rc.prediction.maxBetUsd,
    priceAggression: rc.prediction.priceAggression,
    minMarketLiquidity: rc.marketFilter.minMarketLiquidity,
    minTimeToExpiryMin: rc.marketFilter.minTimeToExpiryMin,
    maxTimeToExpiryMin: rc.marketFilter.maxTimeToExpiryMin,
    cooldownSeconds: rc.marketFilter.cooldownSeconds,
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
