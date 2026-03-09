import axios from "axios";

import type { Config, MarketTarget, SupportedCoin, SupportedHorizon } from "../config.js";
import type { GammaMarket, SelectedMarket } from "../types.js";
import { has5mHint, hasClockHint, hasEthKeyword, minutesUntil, parseJsonArray, toNum } from "../utils.js";

export class GammaClient {
  constructor(private readonly config: Config) {}

  async getCandidateMarkets(limit = 500, now = new Date()): Promise<GammaMarket[]> {
    const defaultTarget: MarketTarget = {
      id: "ETH_5m",
      enabled: true,
      coin: "ETH",
      horizonMin: 5,
      symbol: "ETHUSDT",
      modelPath: this.config.trainedModelPath,
    };
    return this.getCandidateMarketsForTarget(defaultTarget, limit, now);
  }

  async getCandidateMarketsForTarget(target: MarketTarget, limit = 500, now = new Date()): Promise<GammaMarket[]> {
    const slugCandidates = this.buildTargetSlugs(target.coin, target.horizonMin, now);
    const directMarkets = await this.fetchMarketsBySlugs(slugCandidates);
    if (directMarkets.length > 0) {
      return directMarkets;
    }
    return this.getMarkets(limit);
  }

  async getMarkets(limit = 500): Promise<GammaMarket[]> {
    const pageSize = Math.min(Math.max(limit, 100), 1000);
    const maxPages = 5;
    const all: GammaMarket[] = [];
    const seen = new Set<string>();

    for (let page = 0; page < maxPages; page += 1) {
      const offset = page * pageSize;
      const pageData = await this.fetchMarketPage(pageSize, offset);
      if (!pageData.length) break;

      for (const m of pageData) {
        const id = String(m.id ?? "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        all.push(m);
      }

      if (pageData.length < pageSize) break;
    }

    return all;
  }

  getScanStats(markets: GammaMarket[]): { total: number; ethMatched: number; eth5mMatched: number } {
    let ethMatched = 0;
    let eth5mMatched = 0;

    for (const m of markets) {
      const searchable = this.getSearchableText(m);
      if (!searchable) continue;
      if (hasEthKeyword(searchable)) {
        ethMatched += 1;
        if (has5mHint(searchable)) eth5mMatched += 1;
      }
    }

    return { total: markets.length, ethMatched, eth5mMatched };
  }

  selectBestEth5mMarket(
    markets: GammaMarket[],
    now = new Date(),
    excludedMarketIds?: Set<string>,
  ): SelectedMarket | null {
    const defaultTarget: MarketTarget = {
      id: "ETH_5m",
      enabled: true,
      coin: "ETH",
      horizonMin: 5,
      symbol: "ETHUSDT",
      modelPath: this.config.trainedModelPath,
    };
    return this.selectBestMarketForTarget(markets, defaultTarget, now, excludedMarketIds);
  }

  selectBestMarketForTarget(
    markets: GammaMarket[],
    target: MarketTarget,
    now = new Date(),
    excludedMarketIds?: Set<string>,
  ): SelectedMarket | null {
    const strictCandidates: SelectedMarket[] = [];
    const relaxedCandidates: SelectedMarket[] = [];

    for (const m of markets) {
      if (m.closed || m.archived) continue;
      if (m.enableOrderBook === false) continue;

      const searchable = this.getSearchableText(m);
      if (!searchable || !this.hasCoinKeyword(searchable, target.coin)) continue;
      if (!this.hasHorizonHint(searchable, target.horizonMin)) continue;

      const endDate = this.getEndDate(m);
      if (!endDate) continue;
      if (!this.isCurrentTimeWindow(m, endDate, target.horizonMin, now)) continue;

      const minsLeft = minutesUntil(endDate, now);
      if (minsLeft <= 0) continue;

      const liquidity = toNum(m.liquidity, 0);

      const outcomes = parseJsonArray(m.outcomes);
      const outcomePrices = parseJsonArray(m.outcomePrices).map((x) => toNum(x, NaN));
      const clobTokenIds = parseJsonArray(m.clobTokenIds);

      const tokensFromField = Array.isArray(m.tokens) ? m.tokens : [];

      let yesIdx = this.findOutcomeIdx(outcomes, ["yes", "up", "higher", "above"]);
      let noIdx = this.findOutcomeIdx(outcomes, ["no", "down", "lower", "below"]);

      // 避免 outcome 映射歧义：只在能明确识别 yes/no(up/down) 时才交易。
      if (yesIdx < 0 && noIdx >= 0 && outcomes.length === 2) {
        yesIdx = noIdx === 0 ? 1 : 0;
      }
      if (noIdx < 0 && yesIdx >= 0 && outcomes.length === 2) {
        noIdx = yesIdx === 0 ? 1 : 0;
      }
      if (yesIdx < 0 || noIdx < 0 || yesIdx === noIdx) {
        continue;
      }

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
        title: searchable,
        minsLeft,
        liquidity,
        volume: toNum(m.volume, 0),
        targetHorizonMin: target.horizonMin,
      });

      const candidate: SelectedMarket = {
        marketId: String(m.id),
        conditionId: String(m.conditionId ?? m.id),
        title: String(m.question ?? m.title ?? m.slug ?? searchable),
        endDate,
        minsLeft,
        liquidity,
        yesTokenId,
        noTokenId,
        yesPrice,
        noPrice,
        tickSize: Number.isFinite(m.orderPriceMinTickSize) ? Number(m.orderPriceMinTickSize) : 0.01,
        negRisk: Boolean(m.negRisk),
        score,
      };

      if (excludedMarketIds?.has(candidate.marketId)) continue;

      const isStrict =
        minsLeft >= this.config.minTimeToExpiryMin &&
        minsLeft <= this.config.maxTimeToExpiryMin &&
        liquidity >= this.config.minMarketLiquidity;

      if (isStrict) strictCandidates.push(candidate);

      const relaxedMax = Math.max(25, target.horizonMin * 3);
      const relaxedLiquidityFloor = Math.max(100, this.config.minMarketLiquidity * 0.5);
      const isRelaxed = minsLeft <= relaxedMax && liquidity >= relaxedLiquidityFloor;
      if (isRelaxed) relaxedCandidates.push(candidate);
    }

    if (strictCandidates.length) {
      strictCandidates.sort((a, b) => b.score - a.score);
      return strictCandidates[0];
    }
    if (relaxedCandidates.length) {
      relaxedCandidates.sort((a, b) => b.score - a.score);
      return relaxedCandidates[0];
    }

    return null;
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

  private scoreMarket(input: { title: string; minsLeft: number; liquidity: number; volume: number; targetHorizonMin: SupportedHorizon }): number {
    const { title, minsLeft, liquidity, volume, targetHorizonMin } = input;
    let score = 0;

    if (this.hasHorizonHint(title, targetHorizonMin)) score += 100;
    if (hasClockHint(title)) score += 30;

    // 越靠近目标周期到期越优先
    const distancePenalty = 8 * (5 / Math.max(5, targetHorizonMin));
    score += Math.max(0, 40 - Math.abs(minsLeft - targetHorizonMin) * distancePenalty);

    // 流动性与成交量辅助打分
    score += Math.min(30, Math.log10(liquidity + 1) * 8);
    score += Math.min(20, Math.log10(volume + 1) * 5);

    return score;
  }

  private async fetchMarketPage(limit: number, offset: number): Promise<GammaMarket[]> {
    const { data } = await axios.get(`${this.config.gammaHost}/markets`, {
      params: {
        active: true,
        closed: false,
        limit,
        offset,
      },
      timeout: 15000,
    });

    if (Array.isArray(data)) return data as GammaMarket[];
    if (data && Array.isArray(data.data)) return data.data as GammaMarket[];
    return [];
  }

  private async fetchMarketsBySlugs(slugs: string[]): Promise<GammaMarket[]> {
    const all: GammaMarket[] = [];
    const seen = new Set<string>();

    for (const slug of slugs) {
      const markets = await this.fetchMarketsBySlug(slug);
      for (const m of markets) {
        const id = String(m.id ?? "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        all.push(m);
      }
    }

    return all;
  }

  private async fetchMarketsBySlug(slug: string): Promise<GammaMarket[]> {
    const attempts: Array<Record<string, unknown>> = [
      { slug, active: true, closed: false, limit: 50 },
      { slug, limit: 50 },
    ];

    for (const params of attempts) {
      try {
        const { data } = await axios.get(`${this.config.gammaHost}/markets`, {
          params,
          timeout: 15000,
        });
        const markets = Array.isArray(data) ? (data as GammaMarket[]) : (data?.data as GammaMarket[] | undefined) ?? [];
        if (markets.length > 0) return markets;
      } catch {
        continue;
      }
    }

    return [];
  }

  private buildTargetSlugs(coin: SupportedCoin, horizonMin: SupportedHorizon, now = new Date()): string[] {
    const nowSec = Math.floor(now.getTime() / 1000);
    const intervalSec = horizonMin * 60;
    const anchor = Math.ceil(nowSec / intervalSec) * intervalSec;
    const prefixes = this.slugPrefixesForCoin(coin);
    const horizonTag = horizonMin === 60 ? "1h" : `${horizonMin}m`;
    const slugs: string[] = [];

    for (let i = -2; i <= 6; i += 1) {
      const ts = anchor + i * intervalSec;
      for (const p of prefixes) {
        slugs.push(`${p}-updown-${horizonTag}-${ts}`);
      }
    }

    return slugs;
  }

  private getSearchableText(m: GammaMarket): string {
    const tagText = parseJsonArray(m.tags).join(" ");
    const parts = [
      m.question,
      m.title,
      m.description,
      m.slug,
      m.category,
      m.series,
      m.groupTitle,
      m.groupItemTitle,
      m.eventTitle,
      m.ticker,
      tagText,
    ]
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .join(" ");
    return parts;
  }

  private getEndDate(m: GammaMarket): string | null {
    const candidates = [
      m.endDate,
      m.end_date_iso,
      m.closeTime,
      m.expirationTime,
      m.resolveDate,
      m.gameStartTime,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim().length > 0) return c;
    }
    return null;
  }

  private getStartDate(m: GammaMarket): string | null {
    const candidates = [
      m.startDate,
      m.start_date_iso,
      m.startTime,
      m.openTime,
      m.gameStartTime,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim().length > 0) return c;
    }
    return null;
  }

  private isCurrentTimeWindow(m: GammaMarket, endDate: string, horizonMin: SupportedHorizon, now: Date): boolean {
    const endMs = Date.parse(endDate);
    if (!Number.isFinite(endMs)) return false;

    const nowMs = now.getTime();
    if (nowMs >= endMs) return false;
    if (!this.isAlignedWithCurrentWindowEnd(endMs, horizonMin, nowMs)) return false;

    const startDate = this.getStartDate(m);
    if (startDate) {
      const startMs = Date.parse(startDate);
      if (Number.isFinite(startMs)) {
        return nowMs >= startMs && nowMs < endMs;
      }
    }

    // Fallback when start time is absent: alignment check above plus basic not-expired check.
    return true;
  }

  private isAlignedWithCurrentWindowEnd(endMs: number, horizonMin: SupportedHorizon, nowMs: number): boolean {
    const intervalMs = horizonMin * 60_000;
    const expectedEndMs = Math.floor(nowMs / intervalMs) * intervalMs + intervalMs;
    const toleranceMs = 15_000;
    return Math.abs(endMs - expectedEndMs) <= toleranceMs;
  }

  private slugPrefixesForCoin(coin: SupportedCoin): string[] {
    switch (coin) {
      case "BTC":
        return ["btc", "bitcoin"];
      case "ETH":
        return ["eth", "ethereum"];
      case "SOL":
        return ["sol", "solana"];
      case "XRP":
        return ["xrp", "ripple"];
    }
  }

  private hasCoinKeyword(text: string, coin: SupportedCoin): boolean {
    const s = text.toLowerCase();
    switch (coin) {
      case "BTC":
        return /\bbtc\b|\bbitcoin\b/.test(s);
      case "ETH":
        return hasEthKeyword(s);
      case "SOL":
        return /\bsol\b|\bsolana\b/.test(s);
      case "XRP":
        return /\bxrp\b|\bripple\b/.test(s);
      default:
        return false;
    }
  }

  private hasHorizonHint(text: string, horizonMin: SupportedHorizon): boolean {
    const s = text.toLowerCase();
    if (horizonMin === 5) return has5mHint(s);
    if (horizonMin === 15) {
      return ["15m", "15 min", "15-min", "15 minute", "15 minutes", "15分钟"].some((h) => s.includes(h));
    }
    return ["1h", "1 hour", "60m", "60 min", "60-minute", "1小时"].some((h) => s.includes(h));
  }
}
