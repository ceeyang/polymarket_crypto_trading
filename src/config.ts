import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

export const MAX_TARGETS = 4;
export const SUPPORTED_COINS = ["BTC", "ETH", "SOL", "XRP"] as const;
export const SUPPORTED_HORIZONS = [15] as const;

export type SupportedCoin = (typeof SUPPORTED_COINS)[number];
export type SupportedHorizon = (typeof SUPPORTED_HORIZONS)[number];
export type ProviderApiType = "openai_responses" | "openai_chat_compatible";
export type ProviderResponseMode = "json_schema" | "json_object";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface MarketTarget {
  id: string;
  enabled: boolean;
  coin: SupportedCoin;
  horizonMin: SupportedHorizon;
  symbol: string;
}

export interface ResolvedAiProviderConfig {
  id: string;
  label: string;
  apiType: ProviderApiType;
  model: string;
  baseUrl: string;
  apiKeyEnvVar: string;
  apiKey: string;
  reasoningEffort?: ReasoningEffort;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  responseMode: ProviderResponseMode;
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
    horizonMin?: number;
    factLookbackMinutes?: number;
    minConfidence?: number;
    maxOrderNotionalUsd?: number;
    fixedOrderPrice?: number;
    systemPrompt?: string;
    userPromptTemplate?: string;
    targets?: Partial<MarketTarget>[];
  };
  marketFilter: {
    minMarketLiquidity: number;
    minTimeToExpiryMin: number;
    maxTimeToExpiryMin: number;
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
  horizonMin: SupportedHorizon;
  factLookbackMinutes: number;
  minConfidence: number;
  maxOrderNotionalUsd: number;
  fixedOrderPrice: number;
  systemPrompt: string;
  userPromptTemplate: string;
  minMarketLiquidity: number;
  minTimeToExpiryMin: number;
  maxTimeToExpiryMin: number;
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
  provider: ResolvedAiProviderConfig;
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

export const DEFAULT_SYSTEM_PROMPT = [
  "你是一个短周期市场事实分析器。",
  "你只能依据提供给你的事实包做判断，不允许补充未提供的新闻、链上事件或主观猜测。",
  "你的任务是预测未来 15 分钟标的方向，并输出结构化 JSON。",
  "除非输入字段明显缺失、无法解析，或者市场事实明显损坏，否则你必须给出 UP 或 DOWN。",
  "即使优势很弱，也要输出最可能方向，并把 confidence 调低。",
  "tradeable 只表示是否值得执行交易，不影响 direction 的输出。",
  "不要仅仅因为信号混合、波动小或可能已部分定价，就默认输出 ABSTAIN。",
].join("\n");

export const DEFAULT_USER_PROMPT_TEMPLATE = [
  "请基于下面的事实包，判断 {{coin}} 在未来 {{horizonMin}} 分钟的方向。",
  "你面对的是 Polymarket 的 Up/Down 市场，YES 表示 UP，NO 表示 DOWN。",
  "事实包如下：",
  "{{factsJson}}",
  "",
  "输出要求：",
  "1. direction 只能是 UP / DOWN / ABSTAIN；只有输入损坏或无法判断时才允许 ABSTAIN",
  "2. probUp 与 confidence 都必须在 0 到 1 之间",
  "3. 即使 tradeable=false，也必须给出最可能方向",
  "4. reasons 与 risks 要尽量简洁，聚焦事实，不要写空话",
  "5. 若 direction=ABSTAIN，则 tradeable 必须为 false",
].join("\n");

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

function clampNumber(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
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

function normalizeProviderApiType(raw: unknown): ProviderApiType {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "openai_chat_compatible" || v === "chat" || v === "openai-compatible") {
    return "openai_chat_compatible";
  }
  return "openai_responses";
}

function normalizeResponseMode(raw: unknown): ProviderResponseMode {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "json_object" ? "json_object" : "json_schema";
}

function normalizeReasoningEffort(raw: unknown): ReasoningEffort | undefined {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "minimal" || v === "low" || v === "medium" || v === "high") {
    return v;
  }
  return undefined;
}

export function getTargetId(coin: SupportedCoin, horizonMin: SupportedHorizon): string {
  return `${coin}_${horizonMin}m`;
}

function buildDefaultTargets(): MarketTarget[] {
  return SUPPORTED_COINS.map((coin, idx) => ({
    id: getTargetId(coin, 15),
    enabled: idx === 0,
    coin,
    horizonMin: 15,
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
    const horizonMin = normalizeHorizon(t.horizonMin, 15);
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

function parseEnvBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function buildResolvedProvider(input: {
  id?: string;
  label?: string;
  apiType?: unknown;
  model?: string;
  baseUrl?: string;
  apiKeyEnvVar: string;
  apiKey?: string;
  reasoningEffort?: unknown;
  temperature?: unknown;
  maxOutputTokens?: unknown;
  timeoutMs?: unknown;
  responseMode?: unknown;
}): ResolvedAiProviderConfig {
  const apiType = normalizeProviderApiType(input.apiType);
  const model = String(input.model || "").trim();
  const apiKey = String(input.apiKey || "").trim();
  const baseUrl = String(input.baseUrl || (apiType === "openai_responses" ? "https://api.openai.com/v1" : "")).trim();
  return {
    id: String(input.id || "ai_primary").trim() || "ai_primary",
    label: String(input.label || input.id || "AI Primary").trim() || "AI Primary",
    apiType,
    model,
    baseUrl,
    apiKeyEnvVar: input.apiKeyEnvVar,
    apiKey,
    reasoningEffort: normalizeReasoningEffort(input.reasoningEffort),
    temperature: clampNumber(input.temperature, 0, 2, 0.2),
    maxOutputTokens: parsePositiveInt(input.maxOutputTokens, 600),
    timeoutMs: parsePositiveInt(input.timeoutMs, 30000),
    responseMode: normalizeResponseMode(input.responseMode),
  };
}

function buildProviderFromEnv(): ResolvedAiProviderConfig {
  return buildResolvedProvider({
    id: process.env.AI_ID || "deepseek_primary",
    label: process.env.AI_LABEL || "DeepSeek Primary",
    apiType: process.env.AI_API_TYPE || "openai_chat_compatible",
    model: process.env.AI_MODEL || "deepseek-chat",
    baseUrl: process.env.AI_BASE_URL || "https://api.deepseek.com",
    apiKeyEnvVar: "AI_API_KEY",
    apiKey: process.env.AI_API_KEY,
    reasoningEffort: process.env.AI_REASONING_EFFORT,
    temperature: process.env.AI_TEMPERATURE,
    maxOutputTokens: process.env.AI_MAX_OUTPUT_TOKENS,
    timeoutMs: process.env.AI_TIMEOUT_MS,
    responseMode: process.env.AI_RESPONSE_MODE || "json_object",
  });
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

  const fixedOrderPriceRaw = normalizeFixedOrderPrice(rc.prediction.fixedOrderPrice, 0.45);
  const fixedOrderPrice = Math.max(0.01, Math.min(0.99, fixedOrderPriceRaw));

  return {
    dryRun: rc.runtime.dryRun !== false,
    pollIntervalSec: parsePositiveInt(rc.runtime.pollIntervalSec, 20),
    autoClaim: rc.runtime.autoClaim ?? false,
    claimCooldownSec: parsePositiveInt(rc.runtime.claimCooldownSec, 300),
    maxDrawdownPct: parseNonNegativeNumber(rc.runtime.maxDrawdownPct, 0),
    maxOpenTrades: parseNonNegativeInt(rc.runtime.maxOpenTrades, 6),
    maxTradesPerDay: parseNonNegativeInt(rc.runtime.maxTradesPerDay, 120),
    maxConsecutiveLosses: parseNonNegativeInt(rc.runtime.maxConsecutiveLosses, 4),
    horizonMin: normalizeHorizon(rc.prediction.horizonMin, 15),
    factLookbackMinutes: parsePositiveInt(rc.prediction.factLookbackMinutes, 90),
    minConfidence: clampNumber(rc.prediction.minConfidence, 0, 1, 0.55),
    maxOrderNotionalUsd: parsePositiveNumber(rc.prediction.maxOrderNotionalUsd, 2.5),
    fixedOrderPrice,
    systemPrompt: String(rc.prediction.systemPrompt || DEFAULT_SYSTEM_PROMPT).trim() || DEFAULT_SYSTEM_PROMPT,
    userPromptTemplate: String(rc.prediction.userPromptTemplate || DEFAULT_USER_PROMPT_TEMPLATE).trim() || DEFAULT_USER_PROMPT_TEMPLATE,
    minMarketLiquidity: parseNonNegativeNumber(rc.marketFilter.minMarketLiquidity, 300),
    minTimeToExpiryMin: parsePositiveNumber(rc.marketFilter.minTimeToExpiryMin, 5),
    maxTimeToExpiryMin: parsePositiveNumber(rc.marketFilter.maxTimeToExpiryMin, 20),
    minEntrySeconds: parsePositiveInt(rc.marketFilter.minEntrySeconds, 45),
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
    targets: normalizeTargets(rc.prediction.targets),
    provider: buildProviderFromEnv(),
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
