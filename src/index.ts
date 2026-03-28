import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import { Wallet } from "ethers";

import { MAX_TARGETS, loadConfig, readRuntimeConfig, type Config, type MarketTarget } from "./config.js";
import { GammaClient } from "./clients/gamma.js";
import { PolymarketTrader } from "./clients/polymarket.js";
import { readBotControlState, resolveBotControlMode, type BotControlMode } from "./services/bot-control.js";
import { claimRedeemablePositions } from "./services/claim-service.js";
import { StateStore } from "./services/state-store.js";
import type { PredictionAuditRecord, SelectedMarket, SideName } from "./types.js";
import { sleep } from "./utils.js";

const LOG_FILE = path.resolve("state", "runtime.log");
const RELOAD_SIGNAL_FILE = path.resolve("state", "config.reload.signal");
const LOG_TO_STDOUT = !["0", "false", "off", "no"].includes(String(process.env.LOG_TO_STDOUT || "1").trim().toLowerCase());
const AUTO_CLAIM_MAX_RUNTIME_MS = Math.max(
  60_000,
  Math.floor(Number(process.env.AUTO_CLAIM_MAX_RUNTIME_MS || 10 * 60_000)),
);
const LIVE_SYNC_MAX_CHECKS = Math.max(
  10,
  Math.floor(Number(process.env.LIVE_SYNC_MAX_CHECKS || 80)),
);
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
const LOG_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
let lastLogPruneAtMs = 0;

function isLogLineRetained(line: string, cutoffMs: number): boolean {
  try {
    const parsed = JSON.parse(line);
    const ts = Date.parse(String(parsed?.ts ?? ""));
    return !Number.isFinite(ts) || ts >= cutoffMs;
  } catch {
    return true;
  }
}

function pruneRuntimeLogFile(nowMs = Date.now()): void {
  if (nowMs - lastLogPruneAtMs < LOG_PRUNE_INTERVAL_MS) return;
  lastLogPruneAtMs = nowMs;

  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const cutoffMs = nowMs - LOG_RETENTION_MS;
    const raw = fs.readFileSync(LOG_FILE, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const kept = lines.filter((line) => isLogLineRetained(line, cutoffMs));
    if (kept.length === lines.length) return;
    fs.writeFileSync(LOG_FILE, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
  } catch {
    // best effort
  }
}

function appendRuntimeLog(ts: string, msg: string, obj?: unknown): void {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    pruneRuntimeLogFile();
    const payload = obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts, msg, data: payload }) + "\n", "utf8");
  } catch {
    // best effort
  }
}

function formatDate(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${m}-${d} ${h}:${min}`;
}

function log(msg: string, obj?: unknown, tag = "system", level = "info") {
  const tsISO = new Date().toISOString();
  const tsDisplay = formatDate(new Date());
  const tagPart = `[${tag}]`.padEnd(16);
  const levelPart = `[${level}]`.padEnd(10);
  const taggedMsg = `${tagPart} ${levelPart} ${msg}`;

  if (LOG_TO_STDOUT) {
    if (obj == null) {
      console.log(`${tsDisplay} ${taggedMsg}`);
    } else {
      console.log(`${tsDisplay} ${taggedMsg}`, obj);
    }
  }
  appendRuntimeLog(tsISO, `${tsDisplay} ${taggedMsg}`, obj);
}

function logInfo(msg: string, obj?: unknown, tag = "system") { log(msg, obj, tag, "info"); }
function logWarn(msg: string, obj?: unknown, tag = "system") { log(msg, obj, tag, "warn"); }
function logError(msg: string, obj?: unknown, tag = "system") { log(msg, obj, tag, "error"); }
function logSuccess(msg: string, obj?: unknown, tag = "system") { log(msg, obj, tag, "success"); }

function targetLabel(t: MarketTarget): string {
  return `${t.coin}_${t.horizonMin}m`;
}

function isCurrentWindowByEnd(endDate: string, horizonMin: number, nowMs = Date.now()): { ok: boolean; minsToEnd: number; alignDiffMs: number } {
  const endMs = Date.parse(endDate);
  if (!Number.isFinite(endMs)) {
    return { ok: false, minsToEnd: Number.NaN, alignDiffMs: Number.NaN };
  }
  const intervalMs = horizonMin * 60_000;
  const expectedEndMs = Math.floor(nowMs / intervalMs) * intervalMs + intervalMs;
  const alignDiffMs = Math.abs(endMs - expectedEndMs);
  const minsToEnd = (endMs - nowMs) / 60000;
  const ok = minsToEnd > 0 && alignDiffMs <= 15_000;
  return { ok, minsToEnd, alignDiffMs };
}

function cycleStartInfo(
  endDate: string,
  horizonMin: number,
  nowMs = Date.now(),
): { startMs: number; elapsedSec: number; remainingSec: number } | null {
  const endMs = Date.parse(endDate);
  if (!Number.isFinite(endMs)) return null;
  const cycleMs = horizonMin * 60_000;
  const startMs = endMs - cycleMs;
  return {
    startMs,
    elapsedSec: Math.max(0, (nowMs - startMs) / 1000),
    remainingSec: Math.max(0, (endMs - nowMs) / 1000),
  };
}

function withTargetOverrides(cfg: Config, target: MarketTarget): Config {
  return {
    ...cfg,
    horizonMin: target.horizonMin,
  };
}

function resolveSymbol(target: MarketTarget): string {
  return (target.symbol || `${target.coin}USDT`).toUpperCase();
}

function normalizeConditionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(v)) return null;
  return v;
}

function parseFinite(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

function parseOutcomeWin(side: "YES" | "NO", raw: string): boolean | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const yesTokens = ["yes", "up", "higher", "above", "win", "won", "true", "1"];
  const noTokens = ["no", "down", "lower", "below", "lose", "lost", "false", "0"];
  if (yesTokens.some((x) => s.includes(x))) return side === "YES";
  if (noTokens.some((x) => s.includes(x))) return side === "NO";
  return null;
}

function isCancelledOrderStatus(raw: unknown): boolean {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return false;
  // FILLED 和 MATCHED 也是终端状态，不需要也无法撤单
  return s.includes("CANCEL") || s === "EXPIRED" || s === "REJECTED" || s === "FILLED" || s === "MATCHED";
}

function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  if (typeof raw !== "string") return [];
  const text = raw.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x));
  } catch {
    // ignore
  }
  return [];
}

function parseNumberArray(raw: unknown): number[] {
  return parseStringArray(raw)
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));
}

function findOutcomeIdx(outcomes: string[], keywords: string[]): number {
  for (let i = 0; i < outcomes.length; i += 1) {
    const s = outcomes[i]?.toLowerCase?.() ?? "";
    if (!s) continue;
    if (keywords.some((k) => s.includes(k))) return i;
  }
  return -1;
}

function sideToOutcomeIdx(side: "YES" | "NO", outcomes: string[]): number | null {
  if (!outcomes.length) return null;
  let yesIdx = findOutcomeIdx(outcomes, ["yes", "up", "higher", "above", "win", "true"]);
  let noIdx = findOutcomeIdx(outcomes, ["no", "down", "lower", "below", "lose", "false"]);

  if (yesIdx < 0 && noIdx >= 0 && outcomes.length === 2) {
    yesIdx = noIdx === 0 ? 1 : 0;
  }
  if (noIdx < 0 && yesIdx >= 0 && outcomes.length === 2) {
    noIdx = yesIdx === 0 ? 1 : 0;
  }
  if (yesIdx < 0 || noIdx < 0 || yesIdx === noIdx) return null;
  return side === "YES" ? yesIdx : noIdx;
}

interface GammaSettlementParse {
  resolved: boolean;
  winnerIdx: number | null;
  winnerLabel: string | null;
  winnerPrice: number | null;
  outcomes: string[];
}

function parseGammaSettlement(row: any): GammaSettlementParse {
  const outcomes = parseStringArray(row?.outcomes);
  const prices = parseNumberArray(
    row?.outcomePrices
    ?? row?.outcome_prices
    ?? row?.resolutionPrices
    ?? row?.resolution_prices
    ?? row?.finalOutcomePrices
    ?? row?.final_outcome_prices,
  );

  const explicitWinnerIdxRaw =
    row?.winningOutcomeIndex
    ?? row?.winning_outcome_index
    ?? row?.winnerIndex
    ?? row?.winner_index;
  const explicitWinnerIdx = Number(explicitWinnerIdxRaw);
  if (Number.isInteger(explicitWinnerIdx) && explicitWinnerIdx >= 0) {
    const idx = explicitWinnerIdx;
    const winnerLabel = idx < outcomes.length ? outcomes[idx] : null;
    const winnerPrice = idx < prices.length ? prices[idx] : null;
    return { resolved: true, winnerIdx: idx, winnerLabel, winnerPrice, outcomes };
  }

  const explicitWinnerTextRaw =
    row?.winningOutcome
    ?? row?.winning_outcome
    ?? row?.winner
    ?? row?.resolvedOutcome
    ?? row?.resolved_outcome
    ?? row?.result;
  if (typeof explicitWinnerTextRaw === "string" && explicitWinnerTextRaw.trim()) {
    const winnerText = explicitWinnerTextRaw.trim().toLowerCase();
    const idx = outcomes.findIndex((x) => x.toLowerCase() === winnerText || x.toLowerCase().includes(winnerText));
    if (idx >= 0) {
      const winnerPrice = idx < prices.length ? prices[idx] : null;
      return { resolved: true, winnerIdx: idx, winnerLabel: outcomes[idx], winnerPrice, outcomes };
    }
    return { resolved: true, winnerIdx: null, winnerLabel: explicitWinnerTextRaw, winnerPrice: null, outcomes };
  }

  if (prices.length > 0) {
    let bestIdx = -1;
    let best = -Infinity;
    let second = -Infinity;
    for (let i = 0; i < prices.length; i += 1) {
      const p = prices[i];
      if (p > best) {
        second = best;
        best = p;
        bestIdx = i;
      } else if (p > second) {
        second = p;
      }
    }
    if (bestIdx >= 0) {
      const confidentlyResolved = best >= 0.999 || (best - Math.max(second, 0)) >= 0.98;
      if (confidentlyResolved) {
        const winnerLabel = bestIdx < outcomes.length ? outcomes[bestIdx] : null;
        return { resolved: true, winnerIdx: bestIdx, winnerLabel, winnerPrice: best, outcomes };
      }
    }
  }

  const status = String(row?.umaResolutionStatus ?? row?.uma_resolution_status ?? "").toLowerCase();
  const isResolvedByStatus = status === "resolved" || status === "finalized" || status === "settled";
  if (isResolvedByStatus) {
    return { resolved: true, winnerIdx: null, winnerLabel: null, winnerPrice: null, outcomes };
  }
  return { resolved: false, winnerIdx: null, winnerLabel: null, winnerPrice: null, outcomes };
}

function pickUserAddress(cfg: Config): string | null {
  if (cfg.funderAddress && cfg.funderAddress.trim()) return cfg.funderAddress.trim();
  if (!cfg.privateKey) return null;
  try {
    return new Wallet(cfg.privateKey).address;
  } catch {
    return null;
  }
}

interface ClosedPositionSnapshot {
  conditionId: string;
  marketId: string | null;
  pnlUsd: number | null;
  settlementPrice: number | null;
  outcomeText: string | null;
  closedAtMs: number;
}

async function fetchClosedPositionsMap(
  cfg: Config,
  user: string,
): Promise<{ byCondition: Map<string, ClosedPositionSnapshot>; byMarketId: Map<string, ClosedPositionSnapshot> }> {
  const endpoints = [
    { path: "/closed-positions", params: { user, size: 1000 } },
    { path: "/closed_positions", params: { user, size: 1000 } },
    { path: "/positions", params: { user, size: 1000, closed: true } },
  ];

  let rows: any[] = [];
  for (const ep of endpoints) {
    try {
      const { data } = await axios.get(`${cfg.dataApiHost}${ep.path}`, {
        params: ep.params,
        timeout: 20_000,
      });
      const arr = Array.isArray(data) ? data : (Array.isArray((data as any)?.data) ? (data as any).data : []);
      if (Array.isArray(arr)) {
        rows = arr;
        break;
      }
    } catch {
      continue;
    }
  }

  const byCondition = new Map<string, ClosedPositionSnapshot>();
  const byMarketId = new Map<string, ClosedPositionSnapshot>();
  for (const r of rows) {
    const conditionId = normalizeConditionId(r?.conditionId ?? r?.condition_id ?? r?.condition);
    if (!conditionId) continue;
    const marketRaw = r?.marketId ?? r?.market_id ?? r?.market ?? r?.id;
    const marketId = marketRaw == null ? null : String(marketRaw).trim();

    const closedAtMs = Date.parse(
      String(
        r?.closedAt
        ?? r?.closed_at
        ?? r?.resolvedAt
        ?? r?.resolved_at
        ?? r?.endDate
        ?? r?.end_date
        ?? r?.updatedAt
        ?? r?.updated_at
        ?? 0,
      ),
    );

    const pnlUsd = parseFinite(
      r?.realizedPnl
      ?? r?.realized_pnl
      ?? r?.pnl
      ?? r?.profit
      ?? r?.usdPnl
      ?? r?.usdcPnl,
    );

    const settlementPrice = parseFinite(
      r?.settlementPrice
      ?? r?.settlement_price
      ?? r?.resolutionPrice
      ?? r?.resolution_price
      ?? r?.finalPrice
      ?? r?.final_price,
    );

    const outcomeRaw = r?.outcome ?? r?.resolvedOutcome ?? r?.resolved_outcome ?? r?.result;
    const outcomeText = typeof outcomeRaw === "string" ? outcomeRaw : null;

    const prev = byCondition.get(conditionId);
    const ts = Number.isFinite(closedAtMs) ? closedAtMs : 0;
    if (!prev || ts >= prev.closedAtMs) {
      byCondition.set(conditionId, {
        conditionId,
        marketId: marketId || null,
        pnlUsd,
        settlementPrice,
        outcomeText,
        closedAtMs: ts,
      });
    }
  }

  for (const row of byCondition.values()) {
    if (!row.marketId) continue;
    const prev = byMarketId.get(row.marketId);
    if (!prev || row.closedAtMs >= prev.closedAtMs) {
      byMarketId.set(row.marketId, row);
    }
  }

  return { byCondition, byMarketId };
}

async function settleLiveTradesWithOfficial(cfg: Config, state: StateStore, settleBufferMs: number): Promise<{ due: number; resolved: number }> {
  const snapshot = state.load();
  const trades = snapshot.trades ?? [];
  const nowMs = Date.now();
  const dueLive = trades.filter((t) => {
    const mode = t.executionMode ?? (t.orderId ? "LIVE" : "DRY_RUN");
    if (mode !== "LIVE") return false;
    if (isCancelledOrderStatus(t.orderStatus)) return false;
    if (t.resolved) return false;
    const settleMs = Date.parse(t.settleTime);
    if (!Number.isFinite(settleMs)) return false;
    if (nowMs < settleMs + settleBufferMs) return false;
    return true;
  });
  if (!dueLive.length) return { due: 0, resolved: 0 };

  const marketCache = new Map<string, any | null>();
  for (const t of dueLive) {
    const marketId = String(t.marketId || "").trim();
    if (!marketId || marketCache.has(marketId)) continue;
    const market = await fetchGammaMarketById(cfg, marketId);
    marketCache.set(marketId, market);
  }

  let closed: Awaited<ReturnType<typeof fetchClosedPositionsMap>> | null = null;

  let changed = false;
  let resolved = 0;
  for (const t of dueLive) {
    const market = marketCache.get(String(t.marketId || "").trim()) ?? null;
    const outcomes = parseStringArray(market?.outcomes);
    const prices = parseNumberArray(
      market?.outcomePrices
      ?? market?.outcome_prices
      ?? market?.resolutionPrices
      ?? market?.resolution_prices
      ?? market?.finalOutcomePrices
      ?? market?.final_outcome_prices,
    );
    const sideIdx = sideToOutcomeIdx(t.side, outcomes);
    const priceBySide = sideIdx != null && sideIdx >= 0 && sideIdx < prices.length ? prices[sideIdx] : null;
    const entryPrice = parseFinite(t.entryPrice ?? t.entryRefPrice);
    if (entryPrice != null && priceBySide != null && Number.isFinite(priceBySide)) {
      t.resolved = true;
      t.win = priceBySide > entryPrice;
      t.settleRefPrice = Number(priceBySide.toFixed(6));
      t.settlementSource = "POLYMARKET_MARK_PRICE";
      changed = true;
      resolved += 1;
      continue;
    }

    if (closed == null) {
      const user = pickUserAddress(cfg);
      if (user) {
        closed = await fetchClosedPositionsMap(cfg, user);
      } else {
        closed = { byCondition: new Map(), byMarketId: new Map() };
      }
    }
    const cid = normalizeConditionId(t.conditionId);
    const row = (cid ? closed.byCondition.get(cid) : undefined)
      ?? closed.byMarketId.get(String(t.marketId));
    if (!row) continue;

    let win: boolean;
    if (row.pnlUsd != null && Math.abs(row.pnlUsd) > 1e-9) {
      win = row.pnlUsd > 0;
    } else {
      const inferred = row.outcomeText ? parseOutcomeWin(t.side, row.outcomeText) : null;
      win = inferred ?? false;
    }

    t.resolved = true;
    t.win = win;
    if (row.settlementPrice != null) t.settleRefPrice = row.settlementPrice;
    if (row.pnlUsd != null) t.officialPnlUsd = Number(row.pnlUsd.toFixed(6));
    t.settlementSource = "POLYMARKET_OFFICIAL";
    changed = true;
    resolved += 1;
  }

  if (changed) {
    snapshot.trades = trades;
    state.save(snapshot);
  }
  return { due: dueLive.length, resolved };
}

async function fetchGammaMarketById(cfg: Config, marketId: string): Promise<any | null> {
  try {
    const { data } = await axios.get(`${cfg.gammaHost}/markets/${encodeURIComponent(marketId)}`, { timeout: 15_000 });
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
    if (data?.data && typeof data.data === "object" && !Array.isArray(data.data)) return data.data;
    return null;
  } catch {
    return null;
  }
}

async function settleDryRunTradesWithOfficial(
  cfg: Config,
  state: StateStore,
  settleBufferMs: number,
): Promise<{ due: number; resolved: number; reconciled: number }> {
  const snapshot = state.load();
  const trades = snapshot.trades ?? [];
  const nowMs = Date.now();

  const dueDry = trades.filter((t) => {
    const mode = t.executionMode ?? (t.orderId ? "LIVE" : "DRY_RUN");
    if (mode !== "DRY_RUN") return false;
    const settleMs = Date.parse(t.settleTime);
    if (!Number.isFinite(settleMs)) return false;
    if (nowMs < settleMs + settleBufferMs) return false;
    if (!t.marketId || !String(t.marketId).trim()) return false;
    return !t.resolved || t.settlementSource !== "POLYMARKET_OFFICIAL";
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

function toFiniteNumber(raw: unknown, fallback = NaN): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function cancelOrderBestEffort(
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

async function syncLiveOrdersAndCancelStale(
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

        // 如果 API 返回说订单找不到（说明已经在交易所侧取消或成交了），我们设置终结状态
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
      // ignore single-order sync errors, retry next round
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

function pruneExpiredCycleLocks(locks: Map<string, number>, nowMs = Date.now()): void {
  for (const [key, expireMs] of locks.entries()) {
    if (!Number.isFinite(expireMs) || expireMs <= nowMs) {
      locks.delete(key);
    }
  }
}

function cycleLockExpireMs(endDate: string): number {
  const settleMs = Date.parse(endDate);
  if (Number.isFinite(settleMs) && settleMs > 0) return settleMs;
  return Date.now() + 15 * 60_000;
}

function predictionAuditId(targetId: string, marketId: string): string {
  return `${Date.now()}_${targetId}_${marketId}`;
}

interface PreparedOrder {
  target: MarketTarget;
  label: string;
  symbol: string;
  best: SelectedMarket;
  side: SideName;
  orderPlanIndex: number;
  tokenId: string;
  limitPrice: number;
  shareSize: number;
  entryRefPrice: number;
}

interface PreparedEvaluation {
  audit: PredictionAuditRecord;
  best: SelectedMarket;
  orders: PreparedOrder[];
  cycleLockUntilMs: number;
}

interface RuntimeContext {
  cfg: Config;
  cfgKey: string;
  reloadToken: number;
  gamma: GammaClient;
  trader: PolymarketTrader;
  activeTargets: MarketTarget[];
}

type AutoClaimRaceResult =
  | { kind: "result"; summary: Awaited<ReturnType<typeof claimRedeemablePositions>> }
  | { kind: "timeout" };

export interface StartBotOptions {
  controlMode?: BotControlMode;
}

function readConfigKey(): string {
  try {
    return JSON.stringify(readRuntimeConfig());
  } catch {
    return "";
  }
}

function readReloadToken(): number {
  try {
    const raw = fs.readFileSync(RELOAD_SIGNAL_FILE, "utf8").trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    // ignore
  }
  try {
    const st = fs.statSync(RELOAD_SIGNAL_FILE);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

async function buildRuntimeContext(cfgKey: string, reloadToken: number): Promise<RuntimeContext> {
  const cfg = loadConfig();
  const gamma = new GammaClient(cfg);
  const trader = await PolymarketTrader.create(cfg);

  const enabledTargets = cfg.targets.filter((x) => x.enabled).slice(0, MAX_TARGETS);
  if (enabledTargets.length === 0) {
    throw new Error("No enabled targets in config.strategy.targets");
  }

  return {
    cfg,
    cfgKey,
    reloadToken,
    gamma,
    trader,
    activeTargets: enabledTargets,
  };
}

export async function startBot(options?: StartBotOptions): Promise<void> {
  const controlMode = options?.controlMode ?? resolveBotControlMode(process.env.BOT_CONTROL_MODE);
  const state = new StateStore();
  const sessionStartedAt = new Date().toISOString();
  const targetAnalysisLocks = new Map<string, number>();
  let runtime: RuntimeContext | null = null;
  let lastAutoClaimAtMs = 0;
  try {
    const claimFile = path.resolve("state", "last_claim.txt");
    lastAutoClaimAtMs = Number(fs.readFileSync(claimFile, "utf8").trim());
    if (!Number.isFinite(lastAutoClaimAtMs) || lastAutoClaimAtMs <= 0) {
      lastAutoClaimAtMs = Date.now();
      try { fs.writeFileSync(claimFile, String(lastAutoClaimAtMs), "utf8"); } catch {}
    }
  } catch {
    lastAutoClaimAtMs = Date.now(); // 默认记录当前时间，避免启动立即触发
    try { fs.writeFileSync(path.resolve("state", "last_claim.txt"), String(lastAutoClaimAtMs), "utf8"); } catch {}
  }
  let autoClaimInFlight = false;
  let autoClaimRunSeq = 0;
  let cancelStaleInFlight = false;
  let lastScanEnabled: boolean | null = null;
  let liveSyncCursor = 0;
  let reconcileInFlightCount = 0;

  async function reconcileOrder(trader: PolymarketTrader, orderId: string, label: string) {
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

      state.updateTradeStatus(orderId, {
        matchedSize: sizeMatched,
        orderStatus: status,
        entryPrice: avgPrice > 0 ? avgPrice : undefined,
      });

      if (status === "FILLED" || sizeMatched > 0) {
        logInfo(`[${label}] reconciled order status`, { orderId, status, sizeMatched }, "reconcile");
      }
    } catch (err) {
      // ignore
    } finally {
      reconcileInFlightCount--;
    }
  }

  const reloadRuntime = async (reason: string): Promise<RuntimeContext> => {
    const cfgKey = readConfigKey();
    const reloadToken = readReloadToken();
    if (runtime && runtime.cfgKey === cfgKey && runtime.reloadToken === reloadToken) {
      return runtime;
    }

    try {
      const next = await buildRuntimeContext(cfgKey, reloadToken);
      const isStartup = runtime == null;
      runtime = next;

      if (isStartup) {
        logInfo(`bot started dryRun=${next.cfg.dryRun} interval=${next.cfg.pollIntervalSec}s targets=${next.activeTargets.length} controlMode=${controlMode}`, {}, "system");
        logInfo(`session started at ${sessionStartedAt}`, {}, "system");
      } else {
        logInfo("runtime reloaded", {
          reason,
          dryRun: next.cfg.dryRun,
          pollIntervalSec: next.cfg.pollIntervalSec,
          targets: next.activeTargets.length,
          controlMode,
        }, "system");
      }
      logInfo(`auto claim enabled=${next.cfg.autoClaim} interval=${next.cfg.claimIntervalSec}s`, {}, "system");
      logInfo("active targets", next.activeTargets.map((x) => ({
        id: x.id,
        coin: x.coin,
        horizonMin: x.horizonMin,
        symbol: resolveSymbol(x),
      })), "system");
      return next;
    } catch (err) {
      if (!runtime) throw err;
      logError("runtime reload failed, keep previous config", err instanceof Error ? err.message : err, "system");
      return runtime;
    }
  };

  const initialPerfAll = state.getPerformanceSummary("ALL");
  const initialPerfSession = state.getPerformanceSummarySince(sessionStartedAt, "ALL");
  let lastSummaryKey = JSON.stringify({
    totalTrades: initialPerfAll.totalTrades,
    settledTrades: initialPerfAll.settledTrades,
    wins: initialPerfAll.wins,
    winRate: Number((initialPerfAll.winRate * 100).toFixed(2)),
    sessionTrades: initialPerfSession.totalTrades,
    sessionSettledTrades: initialPerfSession.settledTrades,
    sessionWins: initialPerfSession.wins,
    sessionWinRate: Number((initialPerfSession.winRate * 100).toFixed(2)),
  });

  runtime = await reloadRuntime("startup");

  while (true) {
    try {
      const currentRuntime = await reloadRuntime("round_begin");
      const { cfg, gamma, trader, activeTargets } = currentRuntime;
      pruneExpiredCycleLocks(targetAnalysisLocks);

      const perfMode = cfg.dryRun ? "DRY_RUN" : "LIVE";
      const perfAll = state.getPerformanceSummary(perfMode);
      const perfSession = state.getPerformanceSummarySince(sessionStartedAt, perfMode);
      const summaryPayload = {
        totalTrades: perfAll.totalTrades,
        settledTrades: perfAll.settledTrades,
        wins: perfAll.wins,
        winRate: Number((perfAll.winRate * 100).toFixed(2)),
        sessionTrades: perfSession.totalTrades,
        sessionSettledTrades: perfSession.settledTrades,
        sessionWins: perfSession.wins,
        sessionWinRate: Number((perfSession.winRate * 100).toFixed(2)),
        avgFillRate: Number((perfAll.avgFillRate * 100).toFixed(2)),
        totalPnLUsd: Number(perfAll.totalPnLUsd.toFixed(4)),
      };
      const summaryKey = JSON.stringify(summaryPayload);
      if (summaryKey !== lastSummaryKey) {
        logInfo("round summary", summaryPayload, "search-market");
        lastSummaryKey = summaryKey;
      }

      // ── 异步订单对账（独立，非阻塞）──────────────────────────────────────
      if (trader && !cfg.dryRun) {
        const unresolvedTrades = (state.load().trades || [])
          .filter(t => t.executionMode === "LIVE" && t.orderId && !t.resolved)
          .filter(t => !["FILLED", "CANCELED", "EXPIRED"].includes(String(t.orderStatus).toUpperCase()))
          .slice(-30); // 仅追溯最近 30 笔进行对账

        for (const t of unresolvedTrades) {
          if (t.orderId && reconcileInFlightCount < 3) {
            void reconcileOrder(trader, t.orderId, targetLabel({ coin: (t.coin as any), horizonMin: (t.horizonMin as any) } as any));
          }
        }
      }

      // ── 异步撤销过期/已结算挂单（独立 inFlight，不阻塞主循环）─────────────────
      if (!cancelStaleInFlight && !cfg.dryRun) {
        cancelStaleInFlight = true;
        const cancelCfg = cfg;
        const cancelTrader = trader;
        void (async () => {
          try {
            const liveSync = await syncLiveOrdersAndCancelStale(state, cancelTrader, {
              maxChecks: LIVE_SYNC_MAX_CHECKS,
              cursor: liveSyncCursor,
            });
            liveSyncCursor = liveSync.nextCursor;
            if (liveSync.updated > 0 || liveSync.canceled > 0 || liveSync.finalizedCanceled > 0 || liveSync.totalCandidates > LIVE_SYNC_MAX_CHECKS) {
              logInfo("live order sync", liveSync, "cancel-stale");
            }

            const official = await settleLiveTradesWithOfficial(cancelCfg, state, 0);
            if (official.resolved > 0) {
              logInfo("official settlement synced", official, "settle");
            }
          } catch (err) {
            logError("sync error", err instanceof Error ? err.message : err, "cancel-stale");
          } finally {
            cancelStaleInFlight = false;
          }
        })();
      }

      // dry-run 结算（同样异步，不等待）
      void settleDryRunTradesWithOfficial(cfg, state, 0)
        .then((dryRunOfficial) => {
          if (dryRunOfficial.resolved > 0 || dryRunOfficial.reconciled > 0) {
            logInfo("dry-run official settlement synced", dryRunOfficial, "settle");
          }
        })
        .catch((err) => {
          logError("dry-run settle error", err instanceof Error ? err.message : err, "settle");
        });

      // ── 异步领取可领取收益（独立 inFlight，不阻塞主循环）──────────────────────
      if (cfg.autoClaim && !cfg.dryRun && !autoClaimInFlight) {
        const nowMs = Date.now();
        if (nowMs - lastAutoClaimAtMs >= cfg.claimIntervalSec * 1000) {
          const runId = ++autoClaimRunSeq;
          autoClaimInFlight = true;
          lastAutoClaimAtMs = nowMs;
          try { fs.writeFileSync(path.resolve("state", "last_claim.txt"), String(nowMs), "utf8"); } catch {}
          const cfgForClaim = cfg;
          const startedAtMs = Date.now();
          logInfo("started", { runId, timeoutMs: AUTO_CLAIM_MAX_RUNTIME_MS }, "auto-claim");

          const claimPromise = claimRedeemablePositions(cfgForClaim, {
            logPrefix: "[auto-claim]",
            quietNoop: true,
            maxConcurrency: 3,
            logger: log,
          });

          // 独立监听 late error，不影响 race 结果
          claimPromise.catch((err) => {
            logError("late error", {
              runId,
              error: err instanceof Error ? err.message : err,
            }, "auto-claim");
          });

          void Promise.race<AutoClaimRaceResult>([
            claimPromise.then((summary) => ({ kind: "result" as const, summary })),
            sleep(AUTO_CLAIM_MAX_RUNTIME_MS).then(() => ({ kind: "timeout" as const })),
          ])
            .then((outcome) => {
              if (outcome.kind === "timeout") {
                logWarn("timed out", {
                  runId,
                  timeoutMs: AUTO_CLAIM_MAX_RUNTIME_MS,
                  elapsedMs: Date.now() - startedAtMs,
                }, "auto-claim");
                return;
              }
              const claimSummary = outcome.summary;
              if (claimSummary.reason !== "no redeemable condition ids") {
                logSuccess("result", claimSummary, "auto-claim");
              }
            })
            .catch((err) => {
              logError("error", err instanceof Error ? err.message : err, "auto-claim");
            })
            .finally(() => {
              if (runId === autoClaimRunSeq) {
                autoClaimInFlight = false;
              }
            });
        }
      }

      const controlState = readBotControlState();
      const scanEnabled = controlMode === "STANDALONE" ? true : Boolean(controlState.scanningEnabled);
      if (scanEnabled !== lastScanEnabled) {
        logInfo("scan state updated", {
          controlMode,
          scanningEnabled: scanEnabled,
          switchState: controlState.scanningEnabled,
          updatedAt: controlState.updatedAt,
          updatedBy: controlState.updatedBy,
        }, "system");
        lastScanEnabled = scanEnabled;
      }
      if (!scanEnabled) {
        continue;
      }

      const tradedMarketIds = state.getTradedMarketIds();
      const activeContexts = activeTargets.map((target) => ({
        target,
        label: targetLabel(target),
        symbol: resolveSymbol(target),
        mergedCfg: withTargetOverrides(cfg, target),
      }));

      const evaluations = await Promise.all(activeContexts.map(async (ctx): Promise<PreparedEvaluation | null> => {
        const { target, label, symbol, mergedCfg } = ctx;
        try {
          if (targetAnalysisLocks.has(target.id)) return null;

          const markets = await gamma.getCandidateMarketsForTarget(target, 500);
          const best = gamma.selectBestMarketForTarget(markets, target, new Date(), tradedMarketIds);
          if (!best) return null;

          const windowCheck = isCurrentWindowByEnd(best.endDate, target.horizonMin);
          if (!windowCheck.ok) {
            logInfo(`[${label}] skip: not current window`, {
              marketId: best.marketId,
              endDate: best.endDate,
              minsToEnd: Number.isFinite(windowCheck.minsToEnd) ? Number(windowCheck.minsToEnd.toFixed(3)) : null,
              alignDiffMs: Number.isFinite(windowCheck.alignDiffMs) ? Math.round(windowCheck.alignDiffMs) : null,
            }, "search-market");
            return null;
          }

          const startInfo = cycleStartInfo(best.endDate, target.horizonMin);
          if (!startInfo) {
            logInfo(`[${label}] skip: invalid cycle timing`, { marketId: best.marketId, endDate: best.endDate }, "search-market");
            return null;
          }

          const orderEntries = mergedCfg.orderEntries
            .map((entry) => ({
              price: Number(entry.price),
              shareSize: Number(entry.shareSize),
            }))
            .filter((entry) => Number.isFinite(entry.price) && entry.price > 0 && Number.isFinite(entry.shareSize) && entry.shareSize > 0);
          if (!orderEntries.length) {
            logInfo(`[${label}] skip: no valid order entries`, { targetId: target.id }, "search-market");
            return null;
          }

          const plannedOrderEntries = orderEntries.map((entry) => ({
            price: Number(entry.price.toFixed(6)),
            shareSize: Number(entry.shareSize.toFixed(6)),
            plannedNotionalUsd: Number((entry.price * entry.shareSize).toFixed(6)),
          }));
          const plannedNotionalPerSideUsd = Number(plannedOrderEntries.reduce((sum, entry) => sum + entry.plannedNotionalUsd, 0).toFixed(6));
          const ladderText = plannedOrderEntries.map((entry) => `${entry.price.toFixed(4)}x${entry.shareSize}`).join(", ");
          const audit: PredictionAuditRecord = {
            id: predictionAuditId(target.id, best.marketId),
            createdAt: new Date().toISOString(),
            targetId: target.id,
            coin: target.coin,
            symbol,
            horizonMin: target.horizonMin,
            marketId: best.marketId,
            marketTitle: best.title,
            decisionAction: "BUY",
            decisionReason: `dual-sided ladder orders: ${ladderText}`,
            strategyMeta: {
              mode: "DUAL_SIDE_OPENING",
              marketStartTime: new Date(startInfo.startMs).toISOString(),
              marketEndTime: best.endDate,
              orderPrice: plannedOrderEntries[0]?.price,
              orderShareSize: plannedOrderEntries[0]?.shareSize,
              orderEntries: plannedOrderEntries,
              plannedOrderCount: plannedOrderEntries.length * 2,
              plannedNotionalPerSideUsd,
              plannedTotalNotionalUsd: Number((plannedNotionalPerSideUsd * 2).toFixed(6)),
              sides: ["YES", "NO"],
            },
          };

          const orders: PreparedOrder[] = plannedOrderEntries.flatMap((entry, index) => ([
            {
              target,
              label,
              symbol,
              best,
              side: "YES",
              orderPlanIndex: index,
              tokenId: best.yesTokenId,
              limitPrice: entry.price,
              shareSize: entry.shareSize,
              entryRefPrice: best.yesPrice,
            },
            {
              target,
              label,
              symbol,
              best,
              side: "NO",
              orderPlanIndex: index,
              tokenId: best.noTokenId,
              limitPrice: entry.price,
              shareSize: entry.shareSize,
              entryRefPrice: best.noPrice,
            },
          ]));

          return {
            audit,
            best,
            orders,
            cycleLockUntilMs: cycleLockExpireMs(best.endDate),
          };
        } catch (targetErr) {
          logInfo(`[${label}] loop error`, targetErr instanceof Error ? targetErr.message : targetErr, "search-market");
          return null;
        }
      }));

      const readyEvaluations = evaluations.filter((x): x is PreparedEvaluation => Boolean(x));
      for (const evaluation of readyEvaluations) {
        state.recordPrediction(evaluation.audit);
        targetAnalysisLocks.set(evaluation.audit.targetId, evaluation.cycleLockUntilMs);
      }

      for (const evaluation of readyEvaluations) {
        if (tradedMarketIds.has(evaluation.best.marketId)) continue;

        const { audit, best, orders } = evaluation;
        logInfo(`[${audit.targetId}] selected market`, {
          marketId: best.marketId,
          conditionId: best.conditionId,
          title: best.title,
          endDate: best.endDate,
          liquidity: best.liquidity,
          yesPrice: best.yesPrice,
          noPrice: best.noPrice,
          strategyMeta: audit.strategyMeta,
        }, "search-market");

        state.markMarketAttempt(best.marketId);
        tradedMarketIds.add(best.marketId);

        for (const order of orders) {
          const response = await trader.placeBuyOrder({
            tokenId: order.tokenId,
            price: order.limitPrice,
            size: order.shareSize,
            tickSize: best.tickSize,
            negRisk: best.negRisk,
          });

          logInfo(`[${order.label}] order response`, {
            marketId: best.marketId,
            side: order.side,
            orderPlanIndex: order.orderPlanIndex,
            price: order.limitPrice,
            shareSize: order.shareSize,
            response,
          }, "place-order");

          if (response?.dryRun || cfg.dryRun) {
            state.recordTrade({
              marketId: best.marketId,
              conditionId: best.conditionId,
              marketTitle: best.title,
              targetId: order.target.id,
              coin: order.target.coin,
              horizonMin: order.target.horizonMin,
              symbol: order.symbol,
              side: order.side,
              executionMode: "DRY_RUN",
              entryTime: new Date().toISOString(),
              settleTime: best.endDate,
              entryRefPrice: order.entryRefPrice,
              entryPrice: order.limitPrice,
              entryNotionalUsd: Number((order.limitPrice * order.shareSize).toFixed(6)),
              orderPlanIndex: order.orderPlanIndex,
              orderPlanPrice: order.limitPrice,
              orderPlanShareSize: order.shareSize,
              resolved: false,
              orderStatus: "DRY_RUN",
            });
            continue;
          }

          const orderIdRaw = response?.orderID ?? response?.orderId ?? response?.id;
          const orderId = orderIdRaw ? String(orderIdRaw) : undefined;
          if (!orderId) {
            logError(`[${order.label}] skip record: missing order id`, {
              side: order.side,
              response,
            }, "place-order");
            continue;
          }

          state.recordTrade({
            marketId: best.marketId,
            conditionId: best.conditionId,
            marketTitle: best.title,
            targetId: order.target.id,
            coin: order.target.coin,
            horizonMin: order.target.horizonMin,
            symbol: order.symbol,
            side: order.side,
            executionMode: "LIVE",
            entryTime: new Date().toISOString(),
            settleTime: best.endDate,
            entryRefPrice: order.entryRefPrice,
            entryPrice: order.limitPrice,
            entryNotionalUsd: 0,
            orderPlanIndex: order.orderPlanIndex,
            orderPlanPrice: order.limitPrice,
            orderPlanShareSize: order.shareSize,
            resolved: false,
            orderId,
            matchedSize: 0,
            orderStatus: String(response?.status ?? "OPEN"),
          });
        }
      }


    } catch (err) {
      logError("main loop error", err instanceof Error ? err.message : err, "system");
    } finally {
      await sleep((runtime?.cfg.pollIntervalSec ?? 20) * 1000);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  startBot().catch((err) => {
    console.error("fatal error", err);
    process.exit(1);
  });
}
