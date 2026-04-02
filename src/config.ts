import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

export const MAX_TARGETS = 24;
export const MAX_ORDER_ENTRIES = 12;
export const SUPPORTED_COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE"] as const;
export const SUPPORTED_HORIZONS = [5, 15, 60] as const;
export const DEFAULT_ORDER_ENTRIES = Object.freeze([
  { price: 0.10, shareSize: 15 },
  { price: 0.05, shareSize: 20 },
  { price: 0.02, shareSize: 50 },
]);

export type SupportedCoin = (typeof SUPPORTED_COINS)[number];
export type SupportedHorizon = (typeof SUPPORTED_HORIZONS)[number];

export interface MarketTarget {
  id: string;
  enabled: boolean;
  coin: SupportedCoin;
  horizonMin: SupportedHorizon;
  symbol: string;
}

export interface StrategyOrderEntry {
  price: number;
  shareSize: number;
}

export interface RuntimeConfigFile {
  runtime: {
    dryRun: boolean;
    pollIntervalSec: number;
    autoClaim: boolean;
    claimIntervalSec: number;
  };
  strategy: {
    // 双边对冲策略模块
    dualSide: {
      enabled: boolean;
      orderEntries: StrategyOrderEntry[];
    };
    // 高胜率冲刺策略模块
    hwr: {
      enabled: boolean;
      triggerSeconds: number;
      minPrice: number;
      maxPrice: number;
      fixedSizeUsd: number;
    };
    targets: MarketTarget[];
  };
  network: {
    polyHost: string;
    gammaHost: string;
    dataApiHost: string;
    rpcUrl: string;
    rpcUrls?: string[];
    relayerHost: string;
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
  
  // 策略模块化导出
  dualSideEnabled: boolean;
  orderEntries: StrategyOrderEntry[];
  
  hwrEnabled: boolean;
  hwrTriggerSeconds: number;
  hwrMinPrice: number;
  hwrMaxPrice: number;
  hwrFixedSizeUsd: number;
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

function normalizeOrderEntries(rawEntries: Partial<StrategyOrderEntry>[] | undefined, fallbackPrice?: unknown, fallbackShareSize?: unknown): StrategyOrderEntry[] {
  const fallbackOrder = {
    price: Math.max(0.001, Math.min(0.99, normalizeFixedOrderPrice(fallbackPrice, DEFAULT_ORDER_ENTRIES[0].price))),
    shareSize: parsePositiveNumber(fallbackShareSize, DEFAULT_ORDER_ENTRIES[0].shareSize),
  };

  const source = Array.isArray(rawEntries) && rawEntries.length > 0
    ? rawEntries
    : ((fallbackPrice != null || fallbackShareSize != null) ? [fallbackOrder] : DEFAULT_ORDER_ENTRIES);

  const entries: StrategyOrderEntry[] = [];
  for (let i = 0; i < source.length && entries.length < MAX_ORDER_ENTRIES; i += 1) {
    const row = source[i] ?? {};
    const priceRaw = typeof row === "object" && row && "price" in row ? row.price : fallbackOrder.price;
    const shareRaw = typeof row === "object" && row && "shareSize" in row ? row.shareSize : fallbackOrder.shareSize;
    const price = Math.max(0.001, Math.min(0.99, normalizeFixedOrderPrice(priceRaw, fallbackOrder.price)));
    const shareSize = parsePositiveNumber(shareRaw, fallbackOrder.shareSize);
    entries.push({
      price: Number(price.toFixed(6)),
      shareSize: Number(shareSize.toFixed(6)),
    });
  }

  if (entries.length === 0) {
    return DEFAULT_ORDER_ENTRIES.map((entry) => ({ ...entry }));
  }

  return entries.sort((a, b) => {
    if (b.price !== a.price) return b.price - a.price;
    return b.shareSize - a.shareSize;
  });
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
  const out: MarketTarget[] = [];
  for (const coin of SUPPORTED_COINS) {
    for (const horizonMin of SUPPORTED_HORIZONS) {
      out.push({
        id: getTargetId(coin, horizonMin),
        enabled: coin === "BTC" && horizonMin === 5,
        coin,
        horizonMin,
        symbol: `${coin}USDT`,
      });
    }
  }
  return out;
}

function normalizeTargets(rawTargets: Partial<MarketTarget>[] | undefined): MarketTarget[] {
  const defaults = buildDefaultTargets();
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) return defaults;

  const byId = new Map(defaults.map((target) => [target.id, { ...target }]));
  for (let i = 0; i < rawTargets.length; i += 1) {
    const t = rawTargets[i] ?? {};
    const coin = normalizeCoin(t.coin, "BTC");
    const horizonMin = normalizeHorizon(t.horizonMin, 5);
    const id = typeof t.id === "string" && t.id.trim() ? t.id.trim() : getTargetId(coin, horizonMin);
    const prev = byId.get(id);
    const next: MarketTarget = {
      id,
      enabled: Boolean(t.enabled),
      coin,
      horizonMin,
      symbol: typeof t.symbol === "string" && t.symbol.trim() ? t.symbol.trim().toUpperCase() : `${coin}USDT`,
    };
    byId.set(id, prev ? { ...prev, ...next } : next);
  }

  return Array.from(byId.values()).slice(0, MAX_TARGETS);
}

export function readRuntimeConfig(): RuntimeConfigFile {
  if (!fs.existsSync(RUNTIME_CONFIG_PATH)) {
    throw new Error(`Missing runtime config file: ${RUNTIME_CONFIG_PATH}`);
  }
  const raw = fs.readFileSync(RUNTIME_CONFIG_PATH, "utf8");
  return normalizeRuntimeConfigFile(JSON.parse(raw) as RuntimeConfigFile);
}

export function writeRuntimeConfig(next: RuntimeConfigFile): void {
  const dir = path.dirname(RUNTIME_CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(normalizeRuntimeConfigFile(next), null, 2), "utf8");
}

function normalizeRuntimeConfigFile(input: RuntimeConfigFile): RuntimeConfigFile {
  const runtime = {
    dryRun: input.runtime?.dryRun !== false,
    pollIntervalSec: parsePositiveInt(input.runtime?.pollIntervalSec, 20),
    autoClaim: input.runtime?.autoClaim !== false,
    claimIntervalSec: parsePositiveInt(input.runtime?.claimIntervalSec, 1800),
  };

  const dualSide = {
    enabled: input.strategy?.dualSide?.enabled !== false,
    orderEntries: normalizeOrderEntries(
      input.strategy?.dualSide?.orderEntries, 
      (input.strategy as any)?.fixedOrderPrice, 
      (input.strategy as any)?.orderShareSize
    ),
  };

  const hwr = {
    enabled: Boolean(input.strategy?.hwr?.enabled),
    triggerSeconds: parsePositiveInt(input.strategy?.hwr?.triggerSeconds, 60),
    minPrice: typeof input.strategy?.hwr?.minPrice === "number" ? input.strategy.hwr.minPrice : 0.95,
    maxPrice: typeof input.strategy?.hwr?.maxPrice === "number" ? input.strategy.hwr.maxPrice : 0.99,
    fixedSizeUsd: typeof input.strategy?.hwr?.fixedSizeUsd === "number" ? input.strategy.hwr.fixedSizeUsd : 1.0,
  };

  return {
    runtime,
    strategy: {
      dualSide,
      hwr,
      targets: normalizeTargets(input.strategy?.targets),
    },
    network: {
      ...input.network,
      rpcUrls: Array.from(new Set([
        ...(Array.isArray(input.network?.rpcUrls) ? input.network.rpcUrls : []),
        String(input.network?.rpcUrl || "").trim(),
      ].map((x) => String(x || "").trim()).filter(Boolean))),
    },
  };
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
    dryRun: rc.runtime.dryRun,
    pollIntervalSec: rc.runtime.pollIntervalSec,
    autoClaim: rc.runtime.autoClaim,
    claimIntervalSec: rc.runtime.claimIntervalSec,
    
    // 双边策略导出
    dualSideEnabled: rc.strategy.dualSide.enabled,
    orderEntries: rc.strategy.dualSide.orderEntries,
    
    // HWR 策略导出
    hwrEnabled: rc.strategy.hwr.enabled,
    hwrTriggerSeconds: rc.strategy.hwr.triggerSeconds,
    hwrMinPrice: rc.strategy.hwr.minPrice,
    hwrMaxPrice: rc.strategy.hwr.maxPrice,
    hwrFixedSizeUsd: rc.strategy.hwr.fixedSizeUsd,

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
    targets: rc.strategy.targets,
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
