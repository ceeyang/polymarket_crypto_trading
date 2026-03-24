import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

export const MAX_TARGETS = 8;
export const SUPPORTED_COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE"] as const;
export const SUPPORTED_HORIZONS = [5] as const;
export const DEFAULT_ORDER_PRICE = 0.01;
export const DEFAULT_ORDER_SHARE_SIZE = 10;

export type SupportedCoin = (typeof SUPPORTED_COINS)[number];
export type SupportedHorizon = (typeof SUPPORTED_HORIZONS)[number];

export interface MarketTarget {
  id: string;
  enabled: boolean;
  coin: SupportedCoin;
  horizonMin: SupportedHorizon;
  symbol: string;
}

export interface RuntimeConfigFile {
  runtime: {
    dryRun: boolean;
    pollIntervalSec: number;
    autoClaim?: boolean;
    claimIntervalSec?: number;
  };
  strategy: {
    fixedOrderPrice?: number;
    orderShareSize?: number;
    targets?: Partial<MarketTarget>[];
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
}

export interface Config {
  dryRun: boolean;
  pollIntervalSec: number;
  autoClaim: boolean;
  claimIntervalSec: number;
  horizonMin: SupportedHorizon;
  fixedOrderPrice: number;
  orderShareSize: number;
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
}

const RUNTIME_CONFIG_PATH = path.resolve("config", "runtime.json");

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

function parsePositiveNumber(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function normalizeFixedOrderPrice(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  if (n > 1 && n <= 100) return n / 100;
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

export function getTargetId(coin: SupportedCoin, horizonMin: SupportedHorizon): string {
  return `${coin}_${horizonMin}m`;
}

function buildDefaultTargets(): MarketTarget[] {
  return SUPPORTED_COINS.map((coin, idx) => ({
    id: getTargetId(coin, 5),
    enabled: idx === 0,
    coin,
    horizonMin: 5,
    symbol: `${coin}USDT`,
  }));
}

function normalizeTargets(rawTargets: Partial<MarketTarget>[] | undefined): MarketTarget[] {
  const defaults = buildDefaultTargets();
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) return defaults;

  const out: MarketTarget[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawTargets.length && out.length < MAX_TARGETS; i += 1) {
    const t = rawTargets[i] ?? {};
    const coin = normalizeCoin(t.coin, "BTC");
    const horizonMin = normalizeHorizon(t.horizonMin, 5);
    const id = typeof t.id === "string" && t.id.trim() ? t.id.trim() : getTargetId(coin, horizonMin);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      enabled: Boolean(t.enabled),
      coin,
      horizonMin,
      symbol: typeof t.symbol === "string" && t.symbol.trim() ? t.symbol.trim().toUpperCase() : `${coin}USDT`,
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

  return {
    dryRun: rc.runtime.dryRun !== false,
    pollIntervalSec: parsePositiveInt(rc.runtime.pollIntervalSec, 20),
    autoClaim: rc.runtime.autoClaim !== false,
    claimIntervalSec: parsePositiveInt(rc.runtime.claimIntervalSec, 300),
    horizonMin: 5,
    fixedOrderPrice: Math.max(0.001, Math.min(0.99, normalizeFixedOrderPrice(rc.strategy.fixedOrderPrice, DEFAULT_ORDER_PRICE))),
    orderShareSize: parsePositiveNumber(rc.strategy.orderShareSize, DEFAULT_ORDER_SHARE_SIZE),
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
    targets: normalizeTargets(rc.strategy.targets),
    privateKey: process.env.PRIVATE_KEY ?? "",
    funderAddress: process.env.FUNDER_ADDRESS,
    apiKey: process.env.POLY_API_KEY,
    apiSecret: process.env.POLY_API_SECRET,
    apiPassphrase: process.env.POLY_API_PASSPHRASE,
    builderApiKey: process.env.POLY_BUILDER_API_KEY ?? process.env.BUILDER_API_KEY,
    builderSecret: process.env.POLY_BUILDER_SECRET ?? process.env.BUILDER_SECRET,
    builderPassphrase: process.env.POLY_BUILDER_PASSPHRASE ?? process.env.BUILDER_PASSPHRASE ?? process.env.BUILDER_PASS_PHRASE,
  };
}
