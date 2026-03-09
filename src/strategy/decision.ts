import type { Config } from "../config.js";
import type { Prediction, SelectedMarket, TradeDecision } from "../types.js";
import { clamp } from "../utils.js";

export function makeDecision(pred: Prediction, market: SelectedMarket, cfg: Config, horizonMin?: number): TradeDecision {
  const pUp = pred.probUp;
  const pDown = 1 - pUp;
  const preferredSide = pUp >= 0.5 ? "YES" : "NO";
  const edgeYes = pUp - market.yesPrice;
  const edgeNo = pDown - market.noPrice;
  const chosenEdge = preferredSide === "YES" ? edgeYes : edgeNo;

  // 仅允许在每个盘口开始后的前 N 秒内挂单（默认 60s）。
  const cycleSeconds = Number.isFinite(Number(horizonMin)) ? Math.max(1, Math.floor(Number(horizonMin))) * 60 : NaN;
  const entryWindowSec = Math.max(10, Math.floor(cfg.cycleStartWindowSec || 60));
  const remainingSeconds = Math.max(0, market.minsLeft * 60);
  if (Number.isFinite(cycleSeconds)) {
    const cycleStartBoundary = cycleSeconds - entryWindowSec;
    if (remainingSeconds < cycleStartBoundary) {
      return {
        action: "SKIP",
        reason: `outside cycle-start window (${remainingSeconds.toFixed(1)}s left, need >= ${cycleStartBoundary}s)`,
        edge: 0,
      };
    }
  } else if (remainingSeconds < Math.max(cfg.minEntrySeconds, cfg.pollIntervalSec * 2)) {
    return {
      action: "SKIP",
      reason: `time too short (${remainingSeconds.toFixed(1)}s)`,
      edge: 0,
    };
  }

  const tokenId = preferredSide === "YES" ? market.yesTokenId : market.noTokenId;
  if (!tokenId) {
    return {
      action: "SKIP",
      reason: "invalid side token",
      edge: 0,
    };
  }

  if (chosenEdge < cfg.minEdge) {
    return {
      action: "SKIP",
      reason: `no trade signal (edge=${chosenEdge.toFixed(4)} < minEdge=${cfg.minEdge.toFixed(4)})`,
      edge: chosenEdge,
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
    reason: `fixed-price order side=${preferredSide} price=${limitPrice.toFixed(4)} usd=${usdSize.toFixed(4)} predUp=${pUp.toFixed(4)}`,
    side: preferredSide,
    tokenId,
    limitPrice,
    usdSize,
    shareSize,
    edge: chosenEdge,
  };
}
