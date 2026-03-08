import type { Config } from "../config.js";
import type { Prediction, SelectedMarket, TradeDecision } from "../types.js";
import { clamp } from "../utils.js";

export function makeDecision(pred: Prediction, market: SelectedMarket, cfg: Config): TradeDecision {
  const pUp = pred.probUp;
  const pDown = 1 - pUp;

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
    { side: "YES" as const, tokenId: market.yesTokenId, marketPrice: market.yesPrice, edge: edgeYes },
    { side: "NO" as const, tokenId: market.noTokenId, marketPrice: market.noPrice, edge: edgeNo },
  ].sort((a, b) => b.edge - a.edge);

  for (const c of candidates) {
    if (c.edge < cfg.minEdge) continue;

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
    reason: `min shares unmet under max bet (max=${cfg.maxBetUsd.toFixed(4)} minShares=${cfg.minOrderShares.toFixed(2)})`,
    edge: bestEdge,
  };
}
