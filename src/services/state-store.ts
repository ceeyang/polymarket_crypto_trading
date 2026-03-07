import fs from "node:fs";
import path from "node:path";

import type { BotState } from "../types.js";
import { isoNow } from "../utils.js";

export class StateStore {
  private readonly filePath: string;

  constructor(filePath = path.resolve("state", "bot-state.json")) {
    this.filePath = filePath;
  }

  load(): BotState {
    try {
      if (!fs.existsSync(this.filePath)) return { tradedMarkets: {} };
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as BotState;
      return {
        tradedMarkets: parsed.tradedMarkets ?? {},
        lastTradeAt: parsed.lastTradeAt,
      };
    } catch {
      return { tradedMarkets: {} };
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

  markTraded(marketId: string): void {
    const state = this.load();
    state.tradedMarkets[marketId] = isoNow();
    state.lastTradeAt = isoNow();
    this.save(state);
  }

  canTradeByCooldown(cooldownSeconds: number): boolean {
    if (cooldownSeconds <= 0) return true;
    const state = this.load();
    if (!state.lastTradeAt) return true;
    const elapsed = Date.now() - new Date(state.lastTradeAt).getTime();
    return elapsed >= cooldownSeconds * 1000;
  }
}
