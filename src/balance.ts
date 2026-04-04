import "dotenv/config";

import { loadConfig } from "./config.js";
import { fetchAccountSummary } from "./services/account-service.js";
import { fetchActivePositions } from "./services/position-service.js";

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

async function main(): Promise<void> {
  const cfg = loadConfig();
  const showAllowances = process.argv.includes("--show-allowances");

  const [summary, positions] = await Promise.all([
    fetchAccountSummary(),
    fetchActivePositions(cfg, ""), // user is handled inside service via CFG but for now let's pass dummy or user
  ]);

  // wait, fetchActivePositions needs user.
  const user = summary.user;
  if (!user) {
    throw new Error("No user address found.");
  }
  
  // Re-fetch with user
  const realPositions = await fetchActivePositions(cfg, user);

  const openPositions = realPositions.filter((p: any) => Number(p?.size ?? p?.amount ?? 0) > 0);
  const redeemablePositions = openPositions.filter((p: any) => {
    if (!Boolean(p?.redeemable)) return false;
    return extractClaimableUsd(p) > 0;
  });

  console.log("[balance] user", user);
  console.log("[balance] portfolio value", formatUsd(summary.portfolioValueUsd));

  if (summary.collateralError) {
    console.log("[balance] collateral error", summary.collateralError);
  } else {
    console.log("[balance] collateral", {
      balanceRaw: summary.collateralRaw,
      balanceUSDC: formatUnits(summary.collateralRaw, 6),
    });
  }

  console.log("[balance] positions", {
    total: realPositions.length,
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
