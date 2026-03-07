import axios from "axios";

import type { Config } from "../config.js";
import type { GammaMarket, SelectedMarket } from "../types.js";
import { has5mHint, hasClockHint, hasEthKeyword, minutesUntil, parseJsonArray, toNum } from "../utils.js";

export class GammaClient {
  constructor(private readonly config: Config) {}

  async getMarkets(limit = 500): Promise<GammaMarket[]> {
    const { data } = await axios.get(`${this.config.gammaHost}/markets`, {
      params: {
        active: true,
        closed: false,
        limit,
      },
      timeout: 15000,
    });

    if (Array.isArray(data)) return data as GammaMarket[];
    if (data && Array.isArray(data.data)) return data.data as GammaMarket[];
    return [];
  }

  selectBestEth5mMarket(markets: GammaMarket[], now = new Date()): SelectedMarket | null {
    const candidates: SelectedMarket[] = [];

    for (const m of markets) {
      if (m.closed || m.archived) continue;
      if (m.enableOrderBook === false) continue;

      const title = String(m.question ?? m.title ?? m.description ?? m.slug ?? "");
      if (!title || !hasEthKeyword(title)) continue;

      const endDate = m.endDate;
      if (!endDate) continue;

      const minsLeft = minutesUntil(endDate, now);
      if (minsLeft < this.config.minTimeToExpiryMin || minsLeft > this.config.maxTimeToExpiryMin) continue;

      const liquidity = toNum(m.liquidity, 0);
      if (liquidity < this.config.minMarketLiquidity) continue;

      const outcomes = parseJsonArray(m.outcomes);
      const outcomePrices = parseJsonArray(m.outcomePrices).map((x) => toNum(x, NaN));
      const clobTokenIds = parseJsonArray(m.clobTokenIds);

      const tokensFromField = Array.isArray(m.tokens) ? m.tokens : [];

      const yesIdx = this.findOutcomeIdx(outcomes, ["yes", "up", "higher", "above"]);
      const noIdx = this.findOutcomeIdx(outcomes, ["no", "down", "lower", "below"]);

      const yesTokenId =
        (yesIdx >= 0 ? clobTokenIds[yesIdx] : undefined) ??
        tokensFromField.find((t) => (t.outcome ?? "").toLowerCase() === "yes")?.token_id ??
        tokensFromField.find((t) => (t.outcome ?? "").toLowerCase() === "yes")?.tokenId ??
        clobTokenIds[0];

      const noTokenId =
        (noIdx >= 0 ? clobTokenIds[noIdx] : undefined) ??
        tokensFromField.find((t) => (t.outcome ?? "").toLowerCase() === "no")?.token_id ??
        tokensFromField.find((t) => (t.outcome ?? "").toLowerCase() === "no")?.tokenId ??
        clobTokenIds[1];

      if (!yesTokenId || !noTokenId) continue;

      const yesPrice = this.pickPrice(outcomePrices, yesIdx, 0);
      const noPrice = this.pickPrice(outcomePrices, noIdx, 1);

      const score = this.scoreMarket({
        title,
        minsLeft,
        liquidity,
        volume: toNum(m.volume, 0),
      });

      candidates.push({
        marketId: String(m.id),
        conditionId: String(m.conditionId ?? m.id),
        title,
        endDate,
        liquidity,
        yesTokenId,
        noTokenId,
        yesPrice,
        noPrice,
        tickSize: Number.isFinite(m.orderPriceMinTickSize) ? Number(m.orderPriceMinTickSize) : 0.01,
        negRisk: Boolean(m.negRisk),
        score,
      });
    }

    if (!candidates.length) return null;

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  private findOutcomeIdx(outcomes: string[], keywords: string[]): number {
    if (!outcomes.length) return -1;
    for (let i = 0; i < outcomes.length; i += 1) {
      const x = outcomes[i].toLowerCase();
      if (keywords.some((k) => x.includes(k))) return i;
    }
    return -1;
  }

  private pickPrice(prices: number[], preferredIdx: number, fallbackIdx: number): number {
    const a = preferredIdx >= 0 ? prices[preferredIdx] : NaN;
    if (Number.isFinite(a)) return Math.max(0.01, Math.min(0.99, a));
    const b = prices[fallbackIdx];
    if (Number.isFinite(b)) return Math.max(0.01, Math.min(0.99, b));
    return fallbackIdx === 0 ? 0.5 : 0.5;
  }

  private scoreMarket(input: { title: string; minsLeft: number; liquidity: number; volume: number }): number {
    const { title, minsLeft, liquidity, volume } = input;
    let score = 0;

    if (has5mHint(title)) score += 100;
    if (hasClockHint(title)) score += 30;

    // 越靠近 5 分钟目标到期越优先
    score += Math.max(0, 40 - Math.abs(minsLeft - 5) * 8);

    // 流动性与成交量辅助打分
    score += Math.min(30, Math.log10(liquidity + 1) * 8);
    score += Math.min(20, Math.log10(volume + 1) * 5);

    return score;
  }
}
