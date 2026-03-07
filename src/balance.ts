import "dotenv/config";

import axios from "axios";
import { Wallet } from "ethers";

import { PolymarketTrader } from "./clients/polymarket.js";
import { loadConfig } from "./config.js";

function formatUnits(raw: string, decimals: number): string {
  try {
    const neg = raw.startsWith("-");
    const abs = BigInt(neg ? raw.slice(1) : raw);
    const base = 10n ** BigInt(decimals);
    const whole = abs / base;
    const frac = abs % base;
    const fracRaw = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    const wholeWithComma = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${neg ? "-" : ""}${wholeWithComma}${fracRaw ? `.${fracRaw}` : ""}`;
  } catch {
    return raw;
  }
}

function formatUsd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function extractClaimableUsd(position: any): number {
  const candidates = [
    position?.claimableValue,
    position?.claimable_value,
    position?.claimableAmount,
    position?.claimable_amount,
    position?.redeemableValue,
    position?.redeemable_value,
    position?.payoutValue,
    position?.payout_value,
    position?.payout,
    position?.currentValue,
    position?.current_value,
    position?.curValue,
    position?.value,
    position?.usdValue,
    position?.usdcValue,
    position?.finalValue,
    position?.final_value,
  ]
    .map((x) => asNumber(x))
    .filter((x) => x >= 0);

  if (!candidates.length) return 0;
  return Math.max(...candidates);
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

async function main(): Promise<void> {
  const cfg = loadConfig();
  const showAllowances = process.argv.includes("--show-allowances");
  const user = pickAddress(cfg.privateKey, cfg.funderAddress);

  if (!user) {
    throw new Error("No user address found. Set FUNDER_ADDRESS or PRIVATE_KEY in .env");
  }

  const [valueResp, positionsResp] = await Promise.all([
    axios.get(`${cfg.dataApiHost}/value`, { params: { user }, timeout: 15000 }).catch(() => ({ data: null })),
    axios.get(`${cfg.dataApiHost}/positions`, { params: { user, size: 500 }, timeout: 15000 }).catch(() => ({ data: [] })),
  ]);

  const valueData = valueResp.data;
  const positions = Array.isArray(positionsResp.data) ? positionsResp.data : [];

  const openPositions = positions.filter((p: any) => Number(p?.size ?? p?.amount ?? 0) > 0);
  const redeemablePositions = openPositions.filter((p: any) => {
    if (!Boolean(p?.redeemable)) return false;
    return extractClaimableUsd(p) > 0;
  });

  let collateral: any = null;
  if (cfg.privateKey) {
    try {
      const trader = await PolymarketTrader.create(cfg, { forceClient: true });
      collateral = await trader.getBalanceAllowance({ assetType: "COLLATERAL" });
    } catch (err) {
      collateral = { error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    collateral = { error: "PRIVATE_KEY missing, skip collateral balance allowance query" };
  }

  const portfolioRows = Array.isArray(valueData) ? valueData : [];
  const portfolioTotal = portfolioRows.reduce((acc: number, row: any) => acc + asNumber(row?.value), 0);

  console.log("[balance] user", user);
  console.log("[balance] portfolio value", formatUsd(portfolioTotal));

  if (collateral?.error) {
    console.log("[balance] collateral error", collateral.error);
  } else {
    const rawBalance = String(collateral?.balance ?? "0");
    console.log("[balance] collateral", {
      balanceRaw: rawBalance,
      balanceUSDC: formatUnits(rawBalance, 6),
    });

    const allowances = collateral?.allowances && typeof collateral.allowances === "object" ? collateral.allowances : {};
    const allowanceCount = Object.keys(allowances).length;
    console.log("[balance] allowances", {
      count: allowanceCount,
      shown: showAllowances,
    });

    if (showAllowances && allowanceCount > 0) {
      const allowanceRows = Object.entries(allowances).map(([spender, raw]) => ({
        spender,
        raw: String(raw),
        usdc: formatUnits(String(raw), 6),
      }));
      console.table(allowanceRows);
    }
  }

  console.log("[balance] positions", {
    total: positions.length,
    open: openPositions.length,
    redeemable: redeemablePositions.length,
  });

  if (redeemablePositions.length > 0) {
    const preview = redeemablePositions.slice(0, 20).map((p: any) => ({
      conditionId: p?.conditionId ?? p?.condition_id ?? null,
      title: p?.title ?? p?.question ?? p?.market ?? null,
      size: asNumber(p?.size ?? p?.amount ?? 0),
      claimableUsd: extractClaimableUsd(p),
      redeemable: p?.redeemable ?? null,
    }));
    console.log("[balance] redeemable preview", preview);
  }
}

main().catch((err) => {
  console.error("[balance] fatal", err instanceof Error ? err.message : err);
  process.exit(1);
});
