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

function appendRuntimeLog(ts: string, msg: string, obj?: unknown): void {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const payload = obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts, msg, data: payload }) + "\n", "utf8");
  } catch {
    // best effort
  }
}

function log(msg: string, obj?: unknown) {
  const ts = new Date().toISOString();
  if (LOG_TO_STDOUT) {
    if (obj == null) {
      console.log(`[${ts}] ${msg}`);
    } else {
      console.log(`[${ts}] ${msg}`, obj);
    }
  }
  appendRuntimeLog(ts, msg, obj);
}

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
  return s.includes("CANCEL") || s === "EXPIRED" || s === "REJECTED";
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
): Promise<void> {
  try {
    const resp = await trader.cancelOrder(orderId);
    log(`[${context.label}] cancel order`, {
      orderId,
      reason: context.reason,
      response: resp,
    });
  } catch (err) {
    log(`[${context.label}] cancel order failed`, {
      orderId,
      reason: context.reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function syncLiveOrdersAndCancelStale(
  state: StateStore,
  trader: PolymarketTrader,
): Promise<{ checked: number; updated: number; canceled: number; finalizedCanceled: number }> {
  const snapshot = state.load();
  const trades = snapshot.trades ?? [];
  const nowMs = Date.now();
  let checked = 0;
  let updated = 0;
  let canceled = 0;
  let finalizedCanceled = 0;
  let changed = false;

  for (const t of trades) {
    const mode = t.executionMode ?? (t.orderId ? "LIVE" : "DRY_RUN");
    if (mode !== "LIVE") continue;
    if (t.resolved) continue;
    if (!t.orderId || !String(t.orderId).trim()) continue;
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
        await cancelOrderBestEffort(trader, orderId, {
          label: t.targetId || "LIVE_ORDER",
          reason: matchedSize > 0 ? "cancel_remainder_at_settle" : "previous_market_unfilled",
        });
        t.orderStatus = matchedSize > 0 ? "CANCELED_REMAINDER_AT_SETTLE" : "CANCELED_PREV_MARKET_UNFILLED";
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
  return { checked, updated, canceled, finalizedCanceled };
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
  let autoClaimInFlight = false;
  let lastScanEnabled: boolean | null = null;

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
        log(`bot started dryRun=${next.cfg.dryRun} interval=${next.cfg.pollIntervalSec}s targets=${next.activeTargets.length} controlMode=${controlMode}`);
        log(`session started at ${sessionStartedAt}`);
      } else {
        log("runtime reloaded", {
          reason,
          dryRun: next.cfg.dryRun,
          pollIntervalSec: next.cfg.pollIntervalSec,
          targets: next.activeTargets.length,
          controlMode,
        });
      }
      log(`auto claim enabled=${next.cfg.autoClaim} interval=${next.cfg.claimIntervalSec}s`);
      log("active targets", next.activeTargets.map((x) => ({
        id: x.id,
        coin: x.coin,
        horizonMin: x.horizonMin,
        symbol: resolveSymbol(x),
      })));
      return next;
    } catch (err) {
      if (!runtime) throw err;
      log("runtime reload failed, keep previous config", err instanceof Error ? err.message : err);
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

      if (!cfg.dryRun) {
        const liveSync = await syncLiveOrdersAndCancelStale(state, trader);
        if (liveSync.updated > 0 || liveSync.canceled > 0 || liveSync.finalizedCanceled > 0) {
          log("live order sync", liveSync);
        }
        const official = await settleLiveTradesWithOfficial(cfg, state, 0);
        if (official.resolved > 0) {
          log("official settlement synced", official);
        }
      }

      const dryRunOfficial = await settleDryRunTradesWithOfficial(cfg, state, 0);
      if (dryRunOfficial.resolved > 0 || dryRunOfficial.reconciled > 0) {
        log("dry-run official settlement synced", dryRunOfficial);
      }

      if (cfg.autoClaim && !cfg.dryRun && !autoClaimInFlight) {
        const nowMs = Date.now();
        if (nowMs - lastAutoClaimAtMs >= cfg.claimIntervalSec * 1000) {
          autoClaimInFlight = true;
          lastAutoClaimAtMs = nowMs;
          const cfgForClaim = cfg;
          void claimRedeemablePositions(cfgForClaim, {
            logPrefix: "[auto-claim]",
            quietNoop: true,
            maxConcurrency: 3,
          })
            .then((claimSummary) => {
              if (claimSummary.reason !== "no redeemable condition ids") {
                log("auto claim result", claimSummary);
              }
            })
            .catch((err) => {
              log("auto claim error", err instanceof Error ? err.message : err);
            })
            .finally(() => {
              autoClaimInFlight = false;
            });
        }
      }

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
      };
      const summaryKey = JSON.stringify(summaryPayload);
      if (summaryKey !== lastSummaryKey) {
        log("round summary", summaryPayload);
        lastSummaryKey = summaryKey;
      }

      const controlState = readBotControlState();
      const scanEnabled = controlMode === "STANDALONE" ? true : Boolean(controlState.scanningEnabled);
      if (scanEnabled !== lastScanEnabled) {
        log("scan state updated", {
          controlMode,
          scanningEnabled: scanEnabled,
          switchState: controlState.scanningEnabled,
          updatedAt: controlState.updatedAt,
          updatedBy: controlState.updatedBy,
        });
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
            log(`[${label}] skip: not current window`, {
              marketId: best.marketId,
              endDate: best.endDate,
              minsToEnd: Number.isFinite(windowCheck.minsToEnd) ? Number(windowCheck.minsToEnd.toFixed(3)) : null,
              alignDiffMs: Number.isFinite(windowCheck.alignDiffMs) ? Math.round(windowCheck.alignDiffMs) : null,
            });
            return null;
          }

          const startInfo = cycleStartInfo(best.endDate, target.horizonMin);
          if (!startInfo) {
            log(`[${label}] skip: invalid cycle timing`, { marketId: best.marketId, endDate: best.endDate });
            return null;
          }

          const shareSize = Number(mergedCfg.orderShareSize);
          const limitPrice = Number(mergedCfg.fixedOrderPrice);
          const plannedNotionalPerSideUsd = Number((shareSize * limitPrice).toFixed(6));
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
            decisionReason: `dual-sided opening orders at ${limitPrice.toFixed(4)} x ${shareSize}`,
            strategyMeta: {
              mode: "DUAL_SIDE_OPENING",
              marketStartTime: new Date(startInfo.startMs).toISOString(),
              marketEndTime: best.endDate,
              orderPrice: Number(limitPrice.toFixed(6)),
              orderShareSize: Number(shareSize.toFixed(6)),
              plannedNotionalPerSideUsd,
              plannedTotalNotionalUsd: Number((plannedNotionalPerSideUsd * 2).toFixed(6)),
              sides: ["YES", "NO"],
            },
          };

          const orders: PreparedOrder[] = [
            {
              target,
              label,
              symbol,
              best,
              side: "YES",
              tokenId: best.yesTokenId,
              limitPrice,
              shareSize,
              entryRefPrice: best.yesPrice,
            },
            {
              target,
              label,
              symbol,
              best,
              side: "NO",
              tokenId: best.noTokenId,
              limitPrice,
              shareSize,
              entryRefPrice: best.noPrice,
            },
          ];

          return {
            audit,
            best,
            orders,
            cycleLockUntilMs: cycleLockExpireMs(best.endDate),
          };
        } catch (targetErr) {
          log(`[${label}] loop error`, targetErr instanceof Error ? targetErr.message : targetErr);
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
        log(`[${audit.targetId}] selected market`, {
          marketId: best.marketId,
          conditionId: best.conditionId,
          title: best.title,
          endDate: best.endDate,
          liquidity: best.liquidity,
          yesPrice: best.yesPrice,
          noPrice: best.noPrice,
          strategyMeta: audit.strategyMeta,
        });

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

          log(`[${order.label}] order response`, {
            marketId: best.marketId,
            side: order.side,
            response,
          });

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
              resolved: false,
              orderStatus: "DRY_RUN",
            });
            continue;
          }

          const orderIdRaw = response?.orderID ?? response?.orderId ?? response?.id;
          const orderId = orderIdRaw ? String(orderIdRaw) : undefined;
          if (!orderId) {
            log(`[${order.label}] skip record: missing order id`, {
              side: order.side,
              response,
            });
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
            resolved: false,
            orderId,
            matchedSize: 0,
            orderStatus: String(response?.status ?? "OPEN"),
          });
        }
      }
    } catch (err) {
      log("main loop error", err instanceof Error ? err.message : err);
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
