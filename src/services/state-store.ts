import fs from "node:fs";
import path from "node:path";

import type { BotState, LiveTradeRecord, PredictionAuditRecord } from "../types.js";
import { isoNow } from "../utils.js";

type TradeModeFilter = "LIVE" | "DRY_RUN" | "ALL";

function isCancelledTrade(trade: LiveTradeRecord): boolean {
  const status = String(trade.orderStatus || "").trim().toUpperCase();
  if (!status) return false;
  return status.includes("CANCEL") || status === "EXPIRED" || status === "REJECTED";
}

export class StateStore {
  private readonly filePath: string;

  constructor(filePath = path.resolve("state", "bot-state.json")) {
    this.filePath = filePath;
  }

  load(): BotState {
    try {
      if (!fs.existsSync(this.filePath)) return { tradedMarkets: {}, trades: [], predictions: [] };
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as BotState;
      return {
        tradedMarkets: parsed.tradedMarkets ?? {},
        lastTradeAt: parsed.lastTradeAt,
        trades: parsed.trades ?? [],
        predictions: parsed.predictions ?? [],
      };
    } catch {
      return { tradedMarkets: {}, trades: [], predictions: [] };
    }
  }

  save(state: BotState): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2));
  }

  hasTraded(marketId: string): boolean {
    const state = this.load();
    return Boolean(state.tradedMarkets[marketId]);
  }

  getTradedMarketIds(): Set<string> {
    const state = this.load();
    return new Set(Object.keys(state.tradedMarkets ?? {}));
  }

  markMarketAttempt(marketId: string): void {
    const id = String(marketId || "").trim();
    if (!id) return;
    const state = this.load();
    state.tradedMarkets[id] = isoNow();
    this.save(state);
  }

  recordTrade(trade: LiveTradeRecord): void {
    const state = this.load();
    state.tradedMarkets[trade.marketId] = isoNow();
    state.lastTradeAt = isoNow();
    state.trades = state.trades ?? [];
    
    // 检查重复记录
    if (trade.orderId) {
      const exists = state.trades.some(t => t.orderId === trade.orderId);
      if (exists) return;
    }

    state.trades.push(trade);
    this.save(state);
  }

  updateTradeStatus(orderId: string, updates: Partial<LiveTradeRecord>): void {
    const state = this.load();
    const trades = state.trades ?? [];
    let changed = false;
    for (const t of trades) {
      if (t.orderId === orderId) {
        Object.assign(t, updates);
        changed = true;
      }
    }
    if (changed) {
      this.save(state);
    }
  }

  recordPrediction(prediction: PredictionAuditRecord, maxItems = 300): void {
    const state = this.load();
    state.predictions = state.predictions ?? [];
    state.predictions.push(prediction);
    if (state.predictions.length > maxItems) {
      state.predictions = state.predictions.slice(-maxItems);
    }
    this.save(state);
  }

  listPredictions(limit = 100): PredictionAuditRecord[] {
    const state = this.load();
    const predictions = [...(state.predictions ?? [])];
    predictions.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return predictions.slice(0, Math.max(1, limit));
  }

  clearPredictions(): void {
    const state = this.load();
    state.predictions = [];
    this.save(state);
  }

  clearTrades(resetTradedMarkets = true): void {
    const state = this.load();
    state.trades = [];
    state.lastTradeAt = undefined;
    if (resetTradedMarkets) {
      state.tradedMarkets = {};
    }
    this.save(state);
  }

  async settleDueTrades(
    settleBufferMs: number,
    resolver: (trade: LiveTradeRecord) => Promise<number | null>,
    mode: TradeModeFilter = "ALL",
  ): Promise<void> {
    const state = this.load();
    const trades = state.trades ?? [];
    let changed = false;
    const nowMs = Date.now();

    for (const t of trades) {
      if (isCancelledTrade(t)) continue;
      if (t.resolved) continue;
      if (!this.matchesMode(t, mode)) continue;
      const settleMs = Date.parse(t.settleTime);
      if (!Number.isFinite(settleMs)) continue;
      if (nowMs < settleMs + settleBufferMs) continue;

      const settleRefPrice = await resolver(t);
      if (settleRefPrice == null || !Number.isFinite(settleRefPrice)) continue;

      const up = settleRefPrice > t.entryRefPrice;
      t.settleRefPrice = settleRefPrice;
      t.win = (t.side === "YES") === up;
      t.resolved = true;
      t.settlementSource = "BINANCE_PROXY";
      changed = true;
    }

    if (changed) {
      state.trades = trades;
      this.save(state);
    }
  }

  getPerformanceSummary(mode: TradeModeFilter = "ALL"): {
    totalTrades: number;
    settledTrades: number;
    wins: number;
    winRate: number;
    avgFillRate: number;
    totalPnLUsd: number;
  } {
    const state = this.load();
    const trades = (state.trades ?? []).filter((x) => this.matchesMode(x, mode));
    return this.summarize(trades);
  }

  getPerformanceSummarySince(startTime: string, mode: TradeModeFilter = "ALL"): {
    totalTrades: number;
    settledTrades: number;
    wins: number;
    winRate: number;
    avgFillRate: number;
    totalPnLUsd: number;
  } {
    const startMs = Date.parse(startTime);
    const state = this.load();
    const trades = (state.trades ?? []).filter((x) => {
      if (!this.matchesMode(x, mode)) return false;
      const t = Date.parse(x.entryTime);
      if (!Number.isFinite(startMs) || !Number.isFinite(t)) return false;
      return t >= startMs;
    });
    return this.summarize(trades);
  }

  getTradeCountSince(startTime: string, mode: TradeModeFilter = "ALL"): number {
    const startMs = Date.parse(startTime);
    if (!Number.isFinite(startMs)) return 0;
    const state = this.load();
    return (state.trades ?? []).filter((x) => {
      if (!this.matchesMode(x, mode)) return false;
      const t = Date.parse(x.entryTime);
      return Number.isFinite(t) && t >= startMs;
    }).length;
  }

  getOpenTradeCount(mode: TradeModeFilter = "ALL"): number {
    const state = this.load();
    return (state.trades ?? []).filter((x) => this.matchesMode(x, mode) && !x.resolved && !isCancelledTrade(x)).length;
  }

  getConsecutiveLosses(mode: TradeModeFilter = "ALL"): number {
    const state = this.load();
    const trades = (state.trades ?? []).filter((x) => this.matchesMode(x, mode));
    let losses = 0;
    for (let i = trades.length - 1; i >= 0; i -= 1) {
      const t = trades[i];
      if (isCancelledTrade(t)) continue;
      if (!t.resolved) continue;
      if (t.win) break;
      losses += 1;
    }
    return losses;
  }

  getConsecutiveLossesSince(startTime: string, mode: TradeModeFilter = "ALL"): number {
    const startMs = Date.parse(startTime);
    if (!Number.isFinite(startMs)) return 0;
    const state = this.load();
    const trades = (state.trades ?? []).filter((x) => {
      if (!this.matchesMode(x, mode)) return false;
      const t = Date.parse(x.entryTime);
      return Number.isFinite(t) && t >= startMs;
    });
    let losses = 0;
    for (let i = trades.length - 1; i >= 0; i -= 1) {
      const t = trades[i];
      if (isCancelledTrade(t)) continue;
      if (!t.resolved) continue;
      if (t.win) break;
      losses += 1;
    }
    return losses;
  }

  private summarize(trades: LiveTradeRecord[]): {
    totalTrades: number;
    settledTrades: number;
    wins: number;
    winRate: number;
    avgFillRate: number;
    totalPnLUsd: number;
  } {
    const settled = trades.filter((x) => x.resolved && !isCancelledTrade(x));
    const wins = settled.filter((x) => x.win).length;
    
    let totalPlannedSize = 0;
    let totalFilledSize = 0;
    let totalPnL = 0;

    for (const t of trades) {
      totalPlannedSize += (t.orderPlanShareSize || 0);
      totalFilledSize += (t.matchedSize || 0);
      if (t.resolved && t.officialPnlUsd != null) {
        totalPnL += t.officialPnlUsd;
      }
    }

    return {
      totalTrades: trades.length,
      settledTrades: settled.length,
      wins,
      winRate: settled.length > 0 ? wins / settled.length : 0,
      avgFillRate: totalPlannedSize > 0 ? totalFilledSize / totalPlannedSize : 0,
      totalPnLUsd: totalPnL,
    };
  }

  getMarketGroupedSummary(): Array<{
    marketId: string;
    title: string;
    entryTime: string;
    yes: Partial<LiveTradeRecord>;
    no: Partial<LiveTradeRecord>;
    isFullPair: boolean;
    pairPnL: number;
    totalFilled: number;
  }> {
    const state = this.load();
    const trades = state.trades ?? [];
    const groups = new Map<string, any>();

    for (const t of trades) {
      if (!groups.has(t.marketId)) {
        groups.set(t.marketId, {
          marketId: t.marketId,
          title: t.marketTitle || "Unknown",
          entryTime: t.entryTime,
          yes: {},
          no: {},
        });
      }
      const g = groups.get(t.marketId);
      if (t.side === "YES") g.yes = t;
      else g.no = t;
    }

    return Array.from(groups.values()).map(g => {
      const yesFilled = g.yes.matchedSize || 0;
      const noFilled = g.no.matchedSize || 0;
      const isFullPair = yesFilled > 0 && noFilled > 0;
      
      let pairPnL = 0;
      // 简易 PnL：获胜边收益 1.0 - 双边成本
      if (g.yes.resolved && g.no.resolved) {
        const winningSide = g.yes.win ? "YES" : "NO";
        const totalCost = (yesFilled * (g.yes.entryPrice || 0)) + (noFilled * (g.no.entryPrice || 0));
        const totalReturn = winningSide === "YES" ? yesFilled : noFilled;
        pairPnL = totalReturn - totalCost;
      }

      return {
        ...g,
        isFullPair,
        pairPnL,
        totalFilled: yesFilled + noFilled,
      };
    }).sort((a,b) => Date.parse(b.entryTime) - Date.parse(a.entryTime));
  }

  private normalizeMode(trade: LiveTradeRecord): "LIVE" | "DRY_RUN" {
    if (trade.executionMode === "LIVE" || trade.executionMode === "DRY_RUN") {
      return trade.executionMode;
    }
    return trade.orderId && String(trade.orderId).trim() ? "LIVE" : "DRY_RUN";
  }

  private matchesMode(trade: LiveTradeRecord, mode: TradeModeFilter): boolean {
    if (mode === "ALL") return true;
    return this.normalizeMode(trade) === mode;
  }
}
