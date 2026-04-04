import { StateStore } from "./state-store.js";
import { PolymarketTrader } from "../clients/polymarket.js";
import { Config } from "../config.js";
import { fetchGammaMarketById } from "../clients/gamma.js";
import { 
  parseGammaSettlement, 
  sideToOutcomeIdx, 
  parseOutcomeWin 
} from "./settlement-parser.js";
import { 
  toFiniteNumber, 
  isCancelledOrderStatus,
  sleep
} from "../utils.js";
import { logInfo, logError } from "./logger.js";

let reconcileInFlightCount = 0;

/**
 * 异步订单对账
 */
export async function reconcileOrder(state: StateStore, trader: PolymarketTrader, orderId: string, label: string) {
  if (reconcileInFlightCount > 5) return; // 限制并发
  try {
    reconcileInFlightCount++;
    // 随机延迟防封
    await sleep(500 + Math.random() * 2000);

    const res = await trader.getOrder(orderId);
    if (!res) return;

    const sizeMatched = Number(res.size_matched || res.matched_size || 0);
    const status = String(res.status || "UNKNOWN");
    const avgPrice = Number(res.average_filled_price || res.avg_price || 0);

    const prevTrade = state.load().trades?.find((t) => t.orderId === orderId);
    const prevStatus = prevTrade?.orderStatus || "";
    const prevMatched = prevTrade?.matchedSize || 0;

    state.updateTradeStatus(orderId, {
      matchedSize: sizeMatched,
      orderStatus: status,
      entryPrice: avgPrice > 0 ? avgPrice : undefined,
    });

    if ((status !== prevStatus || sizeMatched > prevMatched) && (status === "FILLED" || status === "MATCHED" || sizeMatched > 0)) {
      logInfo(`[${label}] reconciled order status`, { orderId, status, sizeMatched }, "reconcile");
    }
  } catch (err) {
    // ignore
  } finally {
    reconcileInFlightCount--;
  }
}

/**
 * 撤单逻辑（带重试/日志）
 */
export async function cancelOrderBestEffort(
  trader: PolymarketTrader,
  orderId: string,
  context: { label: string; reason: string },
): Promise<any> {
  try {
    const resp = await trader.cancelOrder(orderId);
    logInfo(`[${context.label}] cancel order`, {
      orderId,
      reason: context.reason,
      response: resp,
    }, "cancel-stale");
    return resp;
  } catch (err) {
    logError(`[${context.label}] cancel order failed`, {
      orderId,
      reason: context.reason,
      error: err instanceof Error ? err.message : String(err),
    }, "cancel-stale");
    return null;
  }
}

/**
 * 遍历活跃订单，同步状态并撤销过期订单
 */
export async function syncLiveOrdersAndCancelStale(
  state: StateStore,
  trader: PolymarketTrader,
  options?: { maxChecks?: number; cursor?: number },
): Promise<{ checked: number; updated: number; canceled: number; finalizedCanceled: number; totalCandidates: number; nextCursor: number }> {
  const snapshot = state.load();
  const trades = snapshot.trades ?? [];
  const nowMs = Date.now();
  let checked = 0;
  let updated = 0;
  let canceled = 0;
  let finalizedCanceled = 0;
  let changed = false;

  const candidates = trades
    .map((t, idx) => ({ t, idx }))
    .filter(({ t }) => {
      const mode = t.executionMode ?? (t.orderId ? "LIVE" : "DRY_RUN");
      if (mode !== "LIVE") return false;
      if (t.resolved) return false;
      if (!t.orderId || !String(t.orderId).trim()) return false;
      return true;
    });

  const totalCandidates = candidates.length;
  if (totalCandidates === 0) {
    return {
      checked: 0,
      updated: 0,
      canceled: 0,
      finalizedCanceled: 0,
      totalCandidates: 0,
      nextCursor: 0,
    };
  }

  const limit = Math.max(1, Math.floor(Number(options?.maxChecks ?? totalCandidates)));
  const processCount = Math.min(limit, totalCandidates);
  const rawCursor = Number(options?.cursor ?? 0);
  const startCursor = Number.isFinite(rawCursor)
    ? ((Math.floor(rawCursor) % totalCandidates) + totalCandidates) % totalCandidates
    : 0;

  for (let i = 0; i < processCount; i += 1) {
    const candidate = candidates[(startCursor + i) % totalCandidates];
    const t = candidate.t;
    checked += 1;

    const orderId = String(t.orderId);
    try {
      const ord = await trader.getOrder(orderId);
      const status = String(ord?.status ?? t.orderStatus ?? "UNKNOWN");
      const matchedSize = Math.max(0, toFiniteNumber(ord?.size_matched ?? ord?.sizeMatched ?? t.matchedSize ?? 0, 0));
      const prevStatus = String(t.orderStatus ?? "");
      const prevMatchedSize = Math.max(0, Number(t.matchedSize ?? 0));

      if (status !== prevStatus || Math.abs(matchedSize - prevMatchedSize) > 1e-9) {
        t.orderStatus = status;
        t.matchedSize = matchedSize;
        changed = true;
        updated += 1;
      }

      const settleMs = Date.parse(t.settleTime);
      if (
        matchedSize >= 0
        && Number.isFinite(settleMs)
        && nowMs >= settleMs
        && !isCancelledOrderStatus(status)
      ) {
        const cancelResponse = await cancelOrderBestEffort(trader, orderId, {
          label: t.targetId || "LIVE_ORDER",
          reason: matchedSize > 0 ? "cancel_remainder_at_settle" : "previous_market_unfilled",
        });

        const respStr = JSON.stringify(cancelResponse || "");
        if (respStr.includes("can't be found") || respStr.includes("already canceled or matched")) {
          t.orderStatus = "CANCELED_FINALIZED_BY_API";
        } else {
          t.orderStatus = matchedSize > 0 ? "CANCELED_REMAINDER_AT_SETTLE" : "CANCELED_PREV_MARKET_UNFILLED";
        }

        canceled += 1;
        changed = true;

        if (matchedSize <= 0) {
          t.matchedSize = 0;
          t.entryNotionalUsd = 0;
          t.resolved = true;
          t.settlementSource = "POLYMARKET_MARK_PRICE";
          continue;
        }
      }

      if (isCancelledOrderStatus(status) && matchedSize <= 0) {
        t.orderStatus = status;
        t.matchedSize = 0;
        t.entryNotionalUsd = 0;
        t.resolved = true;
        t.settlementSource = "POLYMARKET_MARK_PRICE";
        finalizedCanceled += 1;
        changed = true;
        continue;
      }

      if (matchedSize > 0) {
        if (!Number.isFinite(Number(t.entryPrice)) || Number(t.entryPrice) <= 0) {
          const fallback = Number.isFinite(Number(t.entryRefPrice)) ? Number(t.entryRefPrice) : 0.5;
          const avgPrice = await trader.getAverageFillPrice(orderId, fallback).catch(() => fallback);
          if (Number.isFinite(avgPrice) && avgPrice > 0) {
            t.entryPrice = avgPrice;
            changed = true;
          }
        }
        const px = Number(t.entryPrice);
        if ((!Number.isFinite(Number(t.entryNotionalUsd)) || Number(t.entryNotionalUsd) <= 0) && Number.isFinite(px) && px > 0) {
          t.entryNotionalUsd = Number((px * matchedSize).toFixed(6));
          changed = true;
        }
      }
    } catch {
      // ignore single-order sync errors
    }
  }

  if (changed) {
    snapshot.trades = trades;
    state.save(snapshot);
  }
  return {
    checked,
    updated,
    canceled,
    finalizedCanceled,
    totalCandidates,
    nextCursor: (startCursor + processCount) % totalCandidates,
  };
}

/**
 * 根据官方市场状态和结算情况，更新交易记录
 */
export async function settleLiveTradesWithOfficial(cfg: Config, state: StateStore, settleBufferMs: number): Promise<{ due: number; resolved: number; reconciled: number }> {
  const snapshot = state.load();
  const trades = snapshot.trades ?? [];
  const nowMs = Date.now();

  const dueDry = trades.filter((t) => {
    const mode = t.executionMode ?? (t.orderId ? "LIVE" : "DRY_RUN");
    if (mode !== "LIVE") return false;
    const settleMs = Date.parse(t.settleTime);
    return Number.isFinite(settleMs) && nowMs >= settleMs + settleBufferMs;
  });
  if (!dueDry.length) return { due: 0, resolved: 0, reconciled: 0 };

  const marketCache = new Map<string, any | null>();
  for (const t of dueDry) {
    const marketId = String(t.marketId);
    if (marketCache.has(marketId)) continue;
    const market = await fetchGammaMarketById(cfg, marketId);
    marketCache.set(marketId, market);
  }

  let changed = false;
  let resolved = 0;
  let reconciled = 0;
  for (const t of dueDry) {
    const market = marketCache.get(String(t.marketId)) ?? null;
    if (!market) continue;

    const settlement = parseGammaSettlement(market);
    if (!settlement.resolved) continue;

    let win: boolean | null = null;
    if (settlement.winnerIdx != null) {
      const sideIdx = sideToOutcomeIdx(t.side, settlement.outcomes);
      if (sideIdx != null) win = sideIdx === settlement.winnerIdx;
    }
    if (win == null && settlement.winnerLabel) {
      win = parseOutcomeWin(t.side, settlement.winnerLabel);
    }
    if (win == null) continue;

    const wasResolved = Boolean(t.resolved);
    const wasOfficial = t.settlementSource === "POLYMARKET_OFFICIAL";
    const wasWin = t.win;

    t.resolved = true;
    t.win = win;
    if (settlement.winnerPrice != null && Number.isFinite(settlement.winnerPrice)) {
      t.settleRefPrice = settlement.winnerPrice;
    }
    t.settlementSource = "POLYMARKET_OFFICIAL";

    const changedNow =
      !wasResolved
      || !wasOfficial
      || wasWin !== win;
    if (changedNow) {
      changed = true;
      if (!wasResolved) {
        resolved += 1;
      } else {
        reconciled += 1;
      }
    }
  }

  if (changed) {
    snapshot.trades = trades;
    state.save(snapshot);
  }
  return { due: dueDry.length, resolved, reconciled };
}
