import fs from "node:fs";
import path from "node:path";

import type { BotState, LiveTradeRecord } from "../types.js";
import { isoNow } from "../utils.js";

export class StateStore {
  private readonly filePath: string;

  constructor(filePath = path.resolve("state", "bot-state.json")) {
    this.filePath = filePath;
  }

  load(): BotState {
    try {
      if (!fs.existsSync(this.filePath)) return { tradedMarkets: {}, trades: [] };
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as BotState;
      return {
        tradedMarkets: parsed.tradedMarkets ?? {},
        lastTradeAt: parsed.lastTradeAt,
        trades: parsed.trades ?? [],
      };
    } catch {
      return { tradedMarkets: {}, trades: [] };
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

  recordTrade(trade: LiveTradeRecord): void {
    const state = this.load();
    state.tradedMarkets[trade.marketId] = isoNow();
    state.lastTradeAt = isoNow();
    state.trades = state.trades ?? [];
    state.trades.push(trade);
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

  canTradeByCooldown(cooldownSeconds: number, targetId?: string): boolean {
    if (cooldownSeconds <= 0) return true;
    const state = this.load();
    const trades = state.trades ?? [];

    if (targetId) {
      let latestMs = NaN;
      for (let i = trades.length - 1; i >= 0; i -= 1) {
        const t = trades[i];
        if (t.targetId !== targetId) continue;
        latestMs = Date.parse(t.entryTime);
        break;
      }
      if (!Number.isFinite(latestMs)) return true;
      return Date.now() - latestMs >= cooldownSeconds * 1000;
    }

    if (!state.lastTradeAt) return true;
    const elapsed = Date.now() - new Date(state.lastTradeAt).getTime();
    return elapsed >= cooldownSeconds * 1000;
  }

  async settleDueTrades(
    settleBufferMs: number,
    resolver: (trade: LiveTradeRecord) => Promise<number | null>,
  ): Promise<void> {
    const state = this.load();
    const trades = state.trades ?? [];
    let changed = false;
    const nowMs = Date.now();

    for (const t of trades) {
      if (t.resolved) continue;
      const settleMs = Date.parse(t.settleTime);
      if (!Number.isFinite(settleMs)) continue;
      if (nowMs < settleMs + settleBufferMs) continue;

      const settleRefPrice = await resolver(t);
      if (settleRefPrice == null || !Number.isFinite(settleRefPrice)) continue;

      const up = settleRefPrice > t.entryRefPrice;
      t.settleRefPrice = settleRefPrice;
      t.win = (t.side === "YES") === up;
      t.resolved = true;
      changed = true;
    }

    if (changed) {
      state.trades = trades;
      this.save(state);
    }
  }

  getPerformanceSummary(): {
    totalTrades: number;
    settledTrades: number;
    wins: number;
    winRate: number;
  } {
    const state = this.load();
    const trades = state.trades ?? [];
    return this.summarize(trades);
  }

  getPerformanceSummarySince(startTime: string): {
    totalTrades: number;
    settledTrades: number;
    wins: number;
    winRate: number;
  } {
    const startMs = Date.parse(startTime);
    const state = this.load();
    const trades = (state.trades ?? []).filter((x) => {
      const t = Date.parse(x.entryTime);
      if (!Number.isFinite(startMs) || !Number.isFinite(t)) return false;
      return t >= startMs;
    });
    return this.summarize(trades);
  }

  getTradeCountSince(startTime: string): number {
    const startMs = Date.parse(startTime);
    if (!Number.isFinite(startMs)) return 0;
    const state = this.load();
    return (state.trades ?? []).filter((x) => {
      const t = Date.parse(x.entryTime);
      return Number.isFinite(t) && t >= startMs;
    }).length;
  }

  getOpenTradeCount(): number {
    const state = this.load();
    return (state.trades ?? []).filter((x) => !x.resolved).length;
  }

  getConsecutiveLosses(): number {
    const state = this.load();
    const trades = state.trades ?? [];
    let losses = 0;
    for (let i = trades.length - 1; i >= 0; i -= 1) {
      const t = trades[i];
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
  } {
    const settled = trades.filter((x) => x.resolved);
    const wins = settled.filter((x) => x.win).length;
    return {
      totalTrades: trades.length,
      settledTrades: settled.length,
      wins,
      winRate: settled.length > 0 ? wins / settled.length : 0,
    };
  }
}
