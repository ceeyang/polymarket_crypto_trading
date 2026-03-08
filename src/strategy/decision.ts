import type { Config } from "../config.js";
import type { Prediction, SelectedMarket, TradeDecision } from "../types.js";
import { clamp } from "../utils.js";

export function makeDecision(pred: Prediction, market: SelectedMarket, cfg: Config): TradeDecision {
  const pUp = pred.probUp;
  const pDown = 1 - pUp;
  const preferredSide = pUp >= 0.5 ? "YES" : "NO";
  const overround = market.yesPrice + market.noPrice;
  if (overround < cfg.minOverround || overround > cfg.maxOverround) {
    return {
      action: "SKIP",
      reason: `overround out of range (${overround.toFixed(4)} not in ${cfg.minOverround.toFixed(4)}-${cfg.maxOverround.toFixed(4)})`,
      edge: 0,
    };
  }

  // 防止“轮询末尾追单”：至少保留两个轮询周期的决策窗口，并受配置最小值约束。
  const minEntrySeconds = Math.max(cfg.minEntrySeconds, cfg.pollIntervalSec * 2);
  const remainingSeconds = Math.max(0, market.minsLeft * 60);
  if (remainingSeconds < minEntrySeconds) {
    return {
      action: "SKIP",
      reason: `time too short (${remainingSeconds.toFixed(1)}s < min ${minEntrySeconds}s)`,
      edge: 0,
    };
  }

  const edgeYes = pUp - market.yesPrice;
  const edgeNo = pDown - market.noPrice;
  const bestEdge = Math.max(edgeYes, edgeNo);

  if (bestEdge < cfg.minEdge) {
    return {
      action: "SKIP",
      reason: `edge too small (best=${bestEdge.toFixed(4)} < min=${cfg.minEdge.toFixed(4)})`,
      edge: bestEdge,
    };
  }

  const candidates = [
    { side: "YES" as const, tokenId: market.yesTokenId, marketPrice: market.yesPrice, edge: edgeYes, modelProb: pUp },
    { side: "NO" as const, tokenId: market.noTokenId, marketPrice: market.noPrice, edge: edgeNo, modelProb: pDown },
  ].sort((a, b) => b.edge - a.edge);

  let reverseRejected = false;
  let reverseDisabled = false;
  let priceRejected = false;
  for (const c of candidates) {
    if (c.edge < cfg.minEdge) continue;
    if (c.marketPrice < cfg.minEntryPrice || c.marketPrice > cfg.maxEntryPrice) {
      priceRejected = true;
      continue;
    }

    // 允许反向兜底，但只在“时间更充足 + 概率不极低 + edge更强”时放行。
    if (c.side !== preferredSide) {
      if (!cfg.enableReverseFallback) {
        reverseDisabled = true;
        continue;
      }
      const reverseEdgeMin = cfg.minEdge * cfg.reverseMinEdgeMultiplier;
      if (remainingSeconds < cfg.reverseMinEntrySeconds) {
        reverseRejected = true;
        continue;
      }
      if (c.modelProb < cfg.reverseMinModelProb || c.edge < reverseEdgeMin) {
        reverseRejected = true;
        continue;
      }
    }

    const limitPrice = clamp(c.marketPrice + cfg.priceAggression, 0.01, 0.99);
    const desiredUsd = clamp(
      cfg.baseBetUsd * (c.edge / cfg.minEdge),
      cfg.baseBetUsd,
      cfg.maxBetUsd,
    );
    const minUsdForShares = cfg.minOrderShares * limitPrice;
    const usdSize = Math.max(desiredUsd, minUsdForShares);

    if (usdSize > cfg.maxBetUsd) continue;

    const shareSize = usdSize / limitPrice;
    return {
      action: "BUY",
      reason: `edge=${c.edge.toFixed(4)} side=${c.side} marketPrice=${c.marketPrice.toFixed(4)} predUp=${pUp.toFixed(4)}`,
      side: c.side,
      tokenId: c.tokenId,
      limitPrice,
      usdSize,
      shareSize,
      edge: c.edge,
    };
  }

  return {
    action: "SKIP",
    reason: reverseDisabled
      ? "reverse fallback disabled"
      : reverseRejected
      ? "reverse fallback rejected by guard (time/probability/price)"
      : priceRejected
        ? `entry price out of range (${cfg.minEntryPrice.toFixed(2)}-${cfg.maxEntryPrice.toFixed(2)})`
      : `min shares unmet under max bet (max=${cfg.maxBetUsd.toFixed(4)} minShares=${cfg.minOrderShares.toFixed(2)})`,
    edge: bestEdge,
  };
}
