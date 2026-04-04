import axios from "axios";
import { Wallet } from "ethers";
import { loadConfig } from "../config.js";
import { PolymarketTrader } from "../clients/polymarket.js";

function rawUsdcToNumber(raw: string): number {
  try {
    return Number(raw) / 1_000_000;
  } catch {
    return 0;
  }
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pickAddress(privateKey: string, funder?: string): string | null {
  if (funder && funder.trim()) return funder.trim();
  if (!privateKey) return null;
  try {
    return new Wallet(privateKey).address;
  } catch {
    return null;
  }
}

export interface AccountSummary {
  user: string | null;
  collateralUsdc: number;
  collateralRaw: string;
  portfolioValueUsd: number;
  totalEquityUsd: number;
  collateralError?: string;
}

let accountCache: { ts: number; data: AccountSummary } | null = null;

export async function fetchAccountSummary(): Promise<AccountSummary> {
  const cfg = loadConfig();
  const user = pickAddress(cfg.privateKey, cfg.funderAddress);
  if (!user) {
    return {
      user: null,
      collateralUsdc: 0,
      collateralRaw: "0",
      portfolioValueUsd: 0,
      totalEquityUsd: 0,
      collateralError: "missing FUNDER_ADDRESS/PRIVATE_KEY",
    };
  }

  const valueResp = await axios.get(`${cfg.dataApiHost}/value`, {
    params: { user },
    timeout: 15000,
  }).catch(() => ({ data: [] }));
  const portfolioRows = Array.isArray(valueResp.data) ? valueResp.data : [];
  const portfolioValueUsd = portfolioRows.reduce((acc: number, row: any) => acc + toNumber(row?.value), 0);

  let collateralRaw = "0";
  let collateralUsdc = 0;
  let collateralError: string | undefined;
  if (!cfg.privateKey) {
    collateralError = "PRIVATE_KEY missing";
  } else {
    try {
      const trader = await PolymarketTrader.create(cfg, { forceClient: true });
      const collateral = await trader.getBalanceAllowance({ assetType: "COLLATERAL" });
      collateralRaw = String(collateral?.balance ?? "0");
      collateralUsdc = rawUsdcToNumber(collateralRaw);
    } catch (err) {
      collateralError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    user,
    collateralUsdc,
    collateralRaw,
    portfolioValueUsd,
    totalEquityUsd: collateralUsdc + portfolioValueUsd,
    collateralError,
  };
}

export async function fetchAccountSummaryCached(maxAgeMs = 8000): Promise<AccountSummary> {
  const now = Date.now();
  if (accountCache && now - accountCache.ts <= maxAgeMs) {
    return accountCache.data;
  }
  const data = await fetchAccountSummary();
  accountCache = { ts: now, data };
  return data;
}

export function invalidateAccountCache(): void {
  accountCache = null;
}
