import "dotenv/config";

export interface Config {
  dryRun: boolean;
  pollIntervalSec: number;
  lookbackMinutes: number;
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
  chainId: number;
  privateKey: string;
  signatureType: number;
  funderAddress?: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
}

function getEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v == null) {
    throw new Error(`Missing env var: ${name}`);
  }
  return v;
}

function getNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid number env var: ${name}=${raw}`);
  }
  return n;
}

function getBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on", "y"].includes(raw.toLowerCase());
}

export function loadConfig(): Config {
  const dryRun = getBool("DRY_RUN", true);
  const privateKey = process.env.PRIVATE_KEY ?? "";

  if (!dryRun && !privateKey) {
    throw new Error("PRIVATE_KEY is required when DRY_RUN=false");
  }

  return {
    dryRun,
    pollIntervalSec: getNum("POLL_INTERVAL_SEC", 30),
    lookbackMinutes: getNum("LOOKBACK_MINUTES", 120),
    minEdge: getNum("MIN_EDGE", 0.03),
    baseBetUsd: getNum("BASE_BET_USD", 10),
    maxBetUsd: getNum("MAX_BET_USD", 30),
    priceAggression: getNum("PRICE_AGGRESSION", 0.01),
    minMarketLiquidity: getNum("MIN_MARKET_LIQUIDITY", 3000),
    minTimeToExpiryMin: getNum("MIN_TIME_TO_EXPIRY_MIN", 1),
    maxTimeToExpiryMin: getNum("MAX_TIME_TO_EXPIRY_MIN", 12),
    cooldownSeconds: getNum("COOLDOWN_SECONDS", 60),
    polyHost: getEnv("POLY_HOST", "https://clob.polymarket.com"),
    gammaHost: getEnv("GAMMA_HOST", "https://gamma-api.polymarket.com"),
    chainId: getNum("CHAIN_ID", 137),
    privateKey,
    signatureType: getNum("SIGNATURE_TYPE", 0),
    funderAddress: process.env.FUNDER_ADDRESS,
    apiKey: process.env.POLY_API_KEY,
    apiSecret: process.env.POLY_API_SECRET,
    apiPassphrase: process.env.POLY_API_PASSPHRASE,
  };
}
