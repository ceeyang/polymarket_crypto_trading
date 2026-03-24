import type { Config } from "../config.js";
import type { Prediction, SelectedMarket, TradeDecision } from "../types.js";
import { clamp } from "../utils.js";

export function makeDecision(pred: Prediction, market: SelectedMarket, cfg: Config, horizonMin?: number): TradeDecision {
  const remainingSeconds = Math.max(0, market.minsLeft * 60);
  if (!Number.isFinite(Number(horizonMin)) && remainingSeconds < Math.max(cfg.minEntrySeconds, cfg.pollIntervalSec * 2)) {
    return {
      action: "SKIP",
      reason: `time too short (${remainingSeconds.toFixed(1)}s)`,
      edge: 0,
    };
  }

  if (pred.direction === "ABSTAIN" || !pred.tradeable) {
    return {
      action: "SKIP",
      reason: "ai returned ABSTAIN or tradeable=false",
      edge: 0,
    };
  }

  if (pred.confidence < cfg.minConfidence) {
    return {
      action: "SKIP",
      reason: `confidence too low (${pred.confidence.toFixed(4)} < minConfidence=${cfg.minConfidence.toFixed(4)})`,
      edge: 0,
    };
  }

  const pUp = pred.probUp;
  const pDown = 1 - pUp;
  const preferredSide = pred.direction === "DOWN" ? "NO" : "YES";
  const edgeYes = pUp - market.yesPrice;
  const edgeNo = pDown - market.noPrice;
  const chosenEdge = preferredSide === "YES" ? edgeYes : edgeNo;

  const tokenId = preferredSide === "YES" ? market.yesTokenId : market.noTokenId;
  if (!tokenId) {
    return {
      action: "SKIP",
      reason: "invalid side token",
      edge: 0,
    };
  }

  const limitPrice = clamp(Number(cfg.fixedOrderPrice || 0.45), 0.01, 0.99);
  const sideMarketPrice = preferredSide === "YES" ? market.yesPrice : market.noPrice;
  const passiveBuffer = Math.max(0.001, Number(market.tickSize || 0.001));
  if (limitPrice >= sideMarketPrice - passiveBuffer) {
    return {
      action: "SKIP",
      reason: `not passive enough (limit=${limitPrice.toFixed(4)} market=${sideMarketPrice.toFixed(4)} buffer=${passiveBuffer.toFixed(4)})`,
      edge: chosenEdge,
    };
  }

  const usdCap = Math.max(0.1, Number(cfg.maxOrderNotionalUsd || 2.5));
  const usdSize = usdCap;
  const shareSize = usdSize / limitPrice;
  return {
    action: "BUY",
    reason: `fixed-price order side=${preferredSide} price=${limitPrice.toFixed(4)} usd=${usdSize.toFixed(4)} probUp=${pUp.toFixed(4)} confidence=${pred.confidence.toFixed(4)}`,
    side: preferredSide,
    tokenId,
    limitPrice,
    usdSize,
    shareSize,
    edge: chosenEdge,
  };
}
