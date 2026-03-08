import { loadConfig } from "./config.js";
import { BinanceClient } from "./clients/binance.js";
import { GammaClient } from "./clients/gamma.js";
import { PolymarketTrader } from "./clients/polymarket.js";
import { makeDecision } from "./strategy/decision.js";
import { loadTrainedModel, predictWithTrainedModel } from "./strategy/trained-model.js";
import { claimRedeemablePositions } from "./services/claim-service.js";
import { StateStore } from "./services/state-store.js";
import { sleep } from "./utils.js";

function log(msg: string, obj?: unknown) {
  const ts = new Date().toISOString();
  if (obj == null) {
    console.log(`[${ts}] ${msg}`);
  } else {
    console.log(`[${ts}] ${msg}`, obj);
  }
}

async function run(): Promise<void> {
  const cfg = loadConfig();
  const gamma = new GammaClient(cfg);
  const binance = new BinanceClient();
  const trader = await PolymarketTrader.create(cfg);
  const state = new StateStore();
  const sessionStartedAt = new Date().toISOString();
  let lastAutoClaimAtMs = 0;
  const trainedModel = loadTrainedModel(cfg.trainedModelPath);
  if (!trainedModel) {
    throw new Error(`Trained model is required but not found/invalid: ${cfg.trainedModelPath}`);
  }

  log(`bot started dryRun=${cfg.dryRun} interval=${cfg.pollIntervalSec}s`);
  log(`session started at ${sessionStartedAt}`);
  log(`auto claim enabled=${cfg.autoClaim} cooldown=${cfg.claimCooldownSec}s`);
  log(`trained model loaded: ${cfg.trainedModelPath}`, trainedModel.metrics ?? {});

  while (true) {
    try {
      await state.settleDueTrades(90_000, async (t) => {
        const settleMs = Date.parse(t.settleTime);
        if (!Number.isFinite(settleMs)) return null;
        return binance.getCloseNearTime("ETHUSDT", settleMs);
      });

      if (cfg.autoClaim && !cfg.dryRun) {
        const nowMs = Date.now();
        if (nowMs - lastAutoClaimAtMs >= cfg.claimCooldownSec * 1000) {
          try {
            const claimSummary = await claimRedeemablePositions(cfg, { logPrefix: "[auto-claim]" });
            log("auto claim result", claimSummary);
          } catch (err) {
            log("auto claim error", err instanceof Error ? err.message : err);
          } finally {
            lastAutoClaimAtMs = nowMs;
          }
        }
      }

      const markets = await gamma.getCandidateMarkets(500);
      const tradedMarketIds = state.getTradedMarketIds();
      const best = gamma.selectBestEth5mMarket(markets, new Date(), tradedMarketIds);

      if (!best) {
        const stats = gamma.getScanStats(markets);
        log("no eligible ETH short-horizon market found", {
          ...stats,
          excludedByTraded: tradedMarketIds.size,
        });
        continue;
      }

      log(`selected market: ${best.title}`);
      log(`market info`, {
        marketId: best.marketId,
        endDate: best.endDate,
        yesPrice: best.yesPrice,
        noPrice: best.noPrice,
        liquidity: best.liquidity,
        score: best.score,
      });

      if (!state.canTradeByCooldown(cfg.cooldownSeconds)) {
        log(`skip: cooldown active (${cfg.cooldownSeconds}s)`);
        continue;
      }

      const closes = await binance.getCloses("ETHUSDT", "1m", Math.max(80, cfg.lookbackMinutes));
      const pred = predictWithTrainedModel(closes, trainedModel);
      if (!pred) {
        throw new Error("trained model prediction failed on current input window");
      }
      const decision = makeDecision(pred, best, cfg);

      log("prediction", pred);
      log("decision", decision);

      const minsToEnd = (Date.parse(best.endDate) - Date.now()) / 60000;
      if (!Number.isFinite(minsToEnd) || minsToEnd <= 0 || minsToEnd > 6) {
        log("skip: not current 5m window market", {
          marketId: best.marketId,
          endDate: best.endDate,
          minsToEnd: Number(minsToEnd.toFixed(3)),
        });
        continue;
      }

      if (decision.action === "SKIP" || !decision.side || !decision.tokenId || !decision.limitPrice || !decision.shareSize) {
        continue;
      }

      const response = await trader.placeBuyOrder({
        tokenId: decision.tokenId,
        price: decision.limitPrice,
        size: decision.shareSize,
        tickSize: best.tickSize,
        negRisk: best.negRisk,
      });

      log("order response", response);
      state.recordTrade({
        marketId: best.marketId,
        side: decision.side,
        entryTime: new Date().toISOString(),
        settleTime: best.endDate,
        entryRefPrice: closes[closes.length - 1],
        resolved: false,
        orderId: response?.orderID ? String(response.orderID) : undefined,
      });
    } catch (err) {
      log("loop error", err instanceof Error ? err.message : err);
    } finally {
      const perfAll = state.getPerformanceSummary();
      const perfSession = state.getPerformanceSummarySince(sessionStartedAt);
      log("round summary", {
        totalTrades: perfAll.totalTrades,
        settledTrades: perfAll.settledTrades,
        wins: perfAll.wins,
        winRate: Number((perfAll.winRate * 100).toFixed(2)),
        sessionTrades: perfSession.totalTrades,
        sessionSettledTrades: perfSession.settledTrades,
        sessionWins: perfSession.wins,
        sessionWinRate: Number((perfSession.winRate * 100).toFixed(2)),
      });

      await sleep(cfg.pollIntervalSec * 1000);
    }
  }
}

run().catch((err) => {
  console.error("fatal error", err);
  process.exit(1);
});
