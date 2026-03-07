import { loadConfig } from "./config.js";
import { BinanceClient } from "./clients/binance.js";
import { GammaClient } from "./clients/gamma.js";
import { PolymarketTrader } from "./clients/polymarket.js";
import { makeDecision } from "./strategy/decision.js";
import { loadTrainedModel, predictWithTrainedModel } from "./strategy/trained-model.js";
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
  const trainedModel = loadTrainedModel(cfg.trainedModelPath);
  if (!trainedModel) {
    throw new Error(`Trained model is required but not found/invalid: ${cfg.trainedModelPath}`);
  }

  log(`bot started dryRun=${cfg.dryRun} interval=${cfg.pollIntervalSec}s`);
  log(`trained model loaded: ${cfg.trainedModelPath}`, trainedModel.metrics ?? {});

  while (true) {
    try {
      await state.settleDueTrades(90_000, async (t) => {
        const settleMs = Date.parse(t.settleTime);
        if (!Number.isFinite(settleMs)) return null;
        return binance.getCloseNearTime("ETHUSDT", settleMs);
      });

      const markets = await gamma.getCandidateMarkets(500);
      const best = gamma.selectBestEth5mMarket(markets);

      if (!best) {
        const stats = gamma.getScanStats(markets);
        log("no eligible ETH short-horizon market found", stats);
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

      if (state.hasTraded(best.marketId)) {
        log(`skip: market already traded marketId=${best.marketId}`);
        continue;
      }

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
      const perf = state.getPerformanceSummary();
      log("round summary", {
        totalTrades: perf.totalTrades,
        settledTrades: perf.settledTrades,
        wins: perf.wins,
        winRate: Number((perf.winRate * 100).toFixed(2)),
      });

      await sleep(cfg.pollIntervalSec * 1000);
    }
  }
}

run().catch((err) => {
  console.error("fatal error", err);
  process.exit(1);
});
