import type { Config } from "../config.js";
import type { Prediction, SelectedMarket, TradeDecision } from "../types.js";
import { clamp } from "../utils.js";

export function makeDecision(pred: Prediction, market: SelectedMarket, cfg: Config): TradeDecision {
  const pUp = pred.probUp;
  const pDown = 1 - pUp;

  const edgeYes = pUp - market.yesPrice;
  const edgeNo = pDown - market.noPrice;

  const chooseYes = edgeYes >= edgeNo;
  const bestEdge = chooseYes ? edgeYes : edgeNo;

  if (bestEdge < cfg.minEdge) {
    return {
      action: "SKIP",
      reason: `edge too small (best=${bestEdge.toFixed(4)} < min=${cfg.minEdge.toFixed(4)})`,
      edge: bestEdge,
    };
  }

  const side = chooseYes ? "YES" : "NO";
  const tokenId = chooseYes ? market.yesTokenId : market.noTokenId;
  const marketPrice = chooseYes ? market.yesPrice : market.noPrice;

  const usdSize = clamp(
    cfg.baseBetUsd * (bestEdge / cfg.minEdge),
    cfg.baseBetUsd,
    cfg.maxBetUsd,
  );

  const limitPrice = clamp(marketPrice + cfg.priceAggression, 0.01, 0.99);
  const shareSize = usdSize / limitPrice;

  return {
    action: "BUY",
    reason: `edge=${bestEdge.toFixed(4)} side=${side} marketPrice=${marketPrice.toFixed(4)} predUp=${pUp.toFixed(4)}`,
    side,
    tokenId,
    limitPrice,
    usdSize,
    shareSize,
    edge: bestEdge,
  };
}
