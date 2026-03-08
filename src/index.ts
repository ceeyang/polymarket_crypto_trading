import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_TARGETS, loadConfig, readRuntimeConfig, type Config, type MarketTarget } from "./config.js";
import { BinanceClient } from "./clients/binance.js";
import { GammaClient } from "./clients/gamma.js";
import { PolymarketTrader } from "./clients/polymarket.js";
import { makeDecision } from "./strategy/decision.js";
import { loadTrainedModel, predictWithTrainedModel, type TrainedModelArtifact } from "./strategy/trained-model.js";
import { claimRedeemablePositions } from "./services/claim-service.js";
import { StateStore } from "./services/state-store.js";
import { sleep } from "./utils.js";

const LOG_FILE = path.resolve("state", "runtime.log");
const RELOAD_SIGNAL_FILE = path.resolve("state", "config.reload.signal");

function appendRuntimeLog(ts: string, msg: string, obj?: unknown): void {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const payload = obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts, msg, data: payload }) + "\n", "utf8");
  } catch {
    // best effort
  }
}

function log(msg: string, obj?: unknown) {
  const ts = new Date().toISOString();
  if (obj == null) {
    console.log(`[${ts}] ${msg}`);
  } else {
    console.log(`[${ts}] ${msg}`, obj);
  }
  appendRuntimeLog(ts, msg, obj);
}

function targetLabel(t: MarketTarget): string {
  return `${t.coin}_${t.horizonMin === 60 ? "1h" : `${t.horizonMin}m`}`;
}

function isCurrentWindowByEnd(endDate: string, horizonMin: number, nowMs = Date.now()): { ok: boolean; minsToEnd: number; alignDiffMs: number } {
  const endMs = Date.parse(endDate);
  if (!Number.isFinite(endMs)) {
    return { ok: false, minsToEnd: Number.NaN, alignDiffMs: Number.NaN };
  }
  const intervalMs = horizonMin * 60_000;
  const expectedEndMs = Math.floor(nowMs / intervalMs) * intervalMs + intervalMs;
  const alignDiffMs = Math.abs(endMs - expectedEndMs);
  const minsToEnd = (endMs - nowMs) / 60000;
  const ok = minsToEnd > 0 && alignDiffMs <= 90_000;
  return { ok, minsToEnd, alignDiffMs };
}

function withTargetOverrides(cfg: Config, target: MarketTarget): Config {
  return {
    ...cfg,
    lookbackMinutes: target.lookbackMinutes ?? cfg.lookbackMinutes,
    minEdge: target.minEdge ?? cfg.minEdge,
    baseBetUsd: target.baseBetUsd ?? cfg.baseBetUsd,
    maxBetUsd: target.maxBetUsd ?? cfg.maxBetUsd,
    minOrderShares: target.minOrderShares ?? cfg.minOrderShares,
    priceAggression: target.priceAggression ?? cfg.priceAggression,
  };
}

function resolveSymbol(target: MarketTarget): string {
  return (target.symbol || `${target.coin}USDT`).toUpperCase();
}

function resolveModelPath(cfg: Config, target: MarketTarget): string {
  return target.modelPath?.trim() ? target.modelPath : cfg.trainedModelPath;
}

function rawUsdcToNumber(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return n / 1_000_000;
}

function startOfLocalDayIso(now = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

interface PreparedOrder {
  target: MarketTarget;
  label: string;
  symbol: string;
  best: {
    marketId: string;
    endDate: string;
    liquidity: number;
    yesPrice: number;
    noPrice: number;
    tickSize: number;
    negRisk: boolean;
  };
  decision: {
    side: "YES" | "NO";
    tokenId: string;
    limitPrice: number;
    shareSize: number;
    edge: number;
  };
  pred: {
    probUp: number;
    confidence: number;
    modelScore: number;
    modelName?: string;
  };
  entryRefPrice: number;
}

interface RuntimeContext {
  cfg: Config;
  cfgKey: string;
  reloadToken: number;
  gamma: GammaClient;
  trader: PolymarketTrader;
  activeTargets: MarketTarget[];
  targetModels: Map<string, TrainedModelArtifact>;
}

function loadTargetModels(cfg: Config, targets: MarketTarget[]): Map<string, TrainedModelArtifact> {
  const models = new Map<string, TrainedModelArtifact>();
  for (const t of targets) {
    const modelPath = resolveModelPath(cfg, t);
    const model = loadTrainedModel(modelPath);
    if (!model) {
      log(`[${targetLabel(t)}] model missing; target disabled this run`, { modelPath });
      continue;
    }
    const symbol = resolveSymbol(t);
    const mismatch: Record<string, string> = {};
    if (model.symbol?.toUpperCase?.() !== symbol) {
      mismatch.modelSymbol = String(model.symbol);
      mismatch.targetSymbol = symbol;
    }
    if (Number(model.horizonMin) !== Number(t.horizonMin)) {
      mismatch.modelHorizonMin = String(model.horizonMin);
      mismatch.targetHorizonMin = String(t.horizonMin);
    }
    if (Object.keys(mismatch).length > 0) {
      log(`[${targetLabel(t)}] model mismatch; target disabled this run`, { modelPath, ...mismatch });
      continue;
    }
    models.set(t.id, model);
    log(`[${targetLabel(t)}] model loaded`, { modelPath, metrics: model.metrics ?? {} });
  }
  return models;
}

function readConfigKey(): string {
  try {
    return JSON.stringify(readRuntimeConfig());
  } catch {
    return "";
  }
}

function readReloadToken(): number {
  try {
    const raw = fs.readFileSync(RELOAD_SIGNAL_FILE, "utf8").trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    // ignore
  }
  try {
    const st = fs.statSync(RELOAD_SIGNAL_FILE);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

async function buildRuntimeContext(cfgKey: string, reloadToken: number): Promise<RuntimeContext> {
  const cfg = loadConfig();
  const gamma = new GammaClient(cfg);
  const trader = await PolymarketTrader.create(cfg);

  const enabledTargets = cfg.targets.filter((x) => x.enabled).slice(0, MAX_TARGETS);
  if (enabledTargets.length === 0) {
    throw new Error("No enabled targets in config.prediction.targets");
  }

  const targetModels = loadTargetModels(cfg, enabledTargets);
  const activeTargets = enabledTargets.filter((t) => targetModels.has(t.id));
  if (activeTargets.length === 0) {
    throw new Error("No active targets with valid models");
  }

  return {
    cfg,
    cfgKey,
    reloadToken,
    gamma,
    trader,
    activeTargets,
    targetModels,
  };
}

export async function startBot(): Promise<void> {
  const binance = new BinanceClient();
  const state = new StateStore();
  const sessionStartedAt = new Date().toISOString();
  let runtime: RuntimeContext | null = null;
  let lastAutoClaimAtMs = 0;
  let autoClaimInFlight = false;
  let lastBalanceCheckAtMs = 0;
  let balanceCheckInFlight = false;
  let peakCollateralUsdc: number | null = null;

  const reloadRuntime = async (reason: string): Promise<RuntimeContext> => {
    const cfgKey = readConfigKey();
    const reloadToken = readReloadToken();
    if (runtime && runtime.cfgKey === cfgKey && runtime.reloadToken === reloadToken) {
      return runtime;
    }

    try {
      const next = await buildRuntimeContext(cfgKey, reloadToken);
      const isStartup = runtime == null;
      runtime = next;

      if (isStartup) {
        log(`bot started dryRun=${next.cfg.dryRun} interval=${next.cfg.pollIntervalSec}s targets=${next.activeTargets.length}`);
        log(`session started at ${sessionStartedAt}`);
      } else {
        log("runtime reloaded", {
          reason,
          dryRun: next.cfg.dryRun,
          pollIntervalSec: next.cfg.pollIntervalSec,
          targets: next.activeTargets.length,
        });
      }
      log(`auto claim enabled=${next.cfg.autoClaim} cooldown=${next.cfg.claimCooldownSec}s`);
      log("active targets", next.activeTargets.map((x) => ({
        id: x.id,
        coin: x.coin,
        horizonMin: x.horizonMin,
        symbol: resolveSymbol(x),
        modelPath: resolveModelPath(next.cfg, x),
      })));
      return next;
    } catch (err) {
      if (!runtime) throw err;
      log("runtime reload failed, keep previous config", err instanceof Error ? err.message : err);
      return runtime;
    }
  };

  const initialPerfAll = state.getPerformanceSummary();
  const initialPerfSession = state.getPerformanceSummarySince(sessionStartedAt);
  let lastSummaryKey = JSON.stringify({
    totalTrades: initialPerfAll.totalTrades,
    settledTrades: initialPerfAll.settledTrades,
    wins: initialPerfAll.wins,
    winRate: Number((initialPerfAll.winRate * 100).toFixed(2)),
    sessionTrades: initialPerfSession.totalTrades,
    sessionSettledTrades: initialPerfSession.settledTrades,
    sessionWins: initialPerfSession.wins,
    sessionWinRate: Number((initialPerfSession.winRate * 100).toFixed(2)),
  });
  let lastRiskGateKey = "";

  runtime = await reloadRuntime("startup");

  while (true) {
    try {
      const currentRuntime = await reloadRuntime("round_begin");
      const { cfg, gamma, trader, activeTargets, targetModels } = currentRuntime;

      await state.settleDueTrades(90_000, async (t) => {
        const settleMs = Date.parse(t.settleTime);
        if (!Number.isFinite(settleMs)) return null;
        return binance.getCloseNearTime(t.symbol || "ETHUSDT", settleMs);
      });

      if (cfg.autoClaim && !cfg.dryRun && !autoClaimInFlight) {
        const nowMs = Date.now();
        if (nowMs - lastAutoClaimAtMs >= cfg.claimCooldownSec * 1000) {
          autoClaimInFlight = true;
          lastAutoClaimAtMs = nowMs;
          const cfgForClaim = cfg;
          void claimRedeemablePositions(cfgForClaim, {
            logPrefix: "[auto-claim]",
            quietNoop: true,
            maxConcurrency: 3,
          })
            .then((claimSummary) => {
              if (claimSummary.reason !== "no redeemable condition ids") {
                log("auto claim result", claimSummary);
              }
            })
            .catch((err) => {
              log("auto claim error", err instanceof Error ? err.message : err);
            })
            .finally(() => {
              autoClaimInFlight = false;
            });
        }
      }

      if (cfg.maxDrawdownPct > 0 && !cfg.dryRun && !balanceCheckInFlight) {
        const nowMs = Date.now();
        if (nowMs - lastBalanceCheckAtMs >= 30_000) {
          balanceCheckInFlight = true;
          lastBalanceCheckAtMs = nowMs;
          const traderForBalance = trader;
          const drawdownLimit = cfg.maxDrawdownPct;
          void traderForBalance.getBalanceAllowance({ assetType: "COLLATERAL" })
            .then((balancePayload) => {
              const currentCollateralUsdc = rawUsdcToNumber(balancePayload?.balance ?? 0);
              if (!Number.isFinite(currentCollateralUsdc) || currentCollateralUsdc <= 0) return;

              if (peakCollateralUsdc == null || currentCollateralUsdc > peakCollateralUsdc) {
                peakCollateralUsdc = currentCollateralUsdc;
              }
              const peak = peakCollateralUsdc ?? currentCollateralUsdc;
              const drawdownPct = peak > 0 ? ((peak - currentCollateralUsdc) / peak) * 100 : 0;

              if (drawdownPct >= drawdownLimit) {
                log("risk stop triggered: max drawdown reached", {
                  drawdownPct: Number(drawdownPct.toFixed(3)),
                  maxDrawdownPct: drawdownLimit,
                  peakCollateralUsdc: Number(peak.toFixed(4)),
                  currentCollateralUsdc: Number(currentCollateralUsdc.toFixed(4)),
                });
                setTimeout(() => process.exit(22), 0);
              }
            })
            .catch((err) => {
              log("balance check error", err instanceof Error ? err.message : err);
            })
            .finally(() => {
              balanceCheckInFlight = false;
            });
        }
      }

      const perfAll = state.getPerformanceSummary();
      const perfSession = state.getPerformanceSummarySince(sessionStartedAt);
      const summaryPayload = {
        totalTrades: perfAll.totalTrades,
        settledTrades: perfAll.settledTrades,
        wins: perfAll.wins,
        winRate: Number((perfAll.winRate * 100).toFixed(2)),
        sessionTrades: perfSession.totalTrades,
        sessionSettledTrades: perfSession.settledTrades,
        sessionWins: perfSession.wins,
        sessionWinRate: Number((perfSession.winRate * 100).toFixed(2)),
      };
      const summaryKey = JSON.stringify(summaryPayload);
      if (summaryKey !== lastSummaryKey) {
        log("round summary", summaryPayload);
        lastSummaryKey = summaryKey;
      }

      const openTrades = state.getOpenTradeCount();
      const tradesToday = state.getTradeCountSince(startOfLocalDayIso());
      const consecutiveLosses = state.getConsecutiveLosses();

      if (cfg.maxConsecutiveLosses > 0 && consecutiveLosses >= cfg.maxConsecutiveLosses) {
        log("risk stop triggered: max consecutive losses reached", {
          consecutiveLosses,
          maxConsecutiveLosses: cfg.maxConsecutiveLosses,
        });
        process.exit(24);
      }

      if (cfg.maxOpenTrades > 0 && openTrades >= cfg.maxOpenTrades) {
        const gateKey = `maxOpenTrades:${openTrades}`;
        if (gateKey !== lastRiskGateKey) {
          log("risk gate active: too many open trades", {
            openTrades,
            maxOpenTrades: cfg.maxOpenTrades,
          });
          lastRiskGateKey = gateKey;
        }
        continue;
      }

      if (cfg.maxTradesPerDay > 0 && tradesToday >= cfg.maxTradesPerDay) {
        const gateKey = `maxTradesPerDay:${tradesToday}`;
        if (gateKey !== lastRiskGateKey) {
          log("risk gate active: daily trade cap reached", {
            tradesToday,
            maxTradesPerDay: cfg.maxTradesPerDay,
          });
          lastRiskGateKey = gateKey;
        }
        continue;
      }

      if (lastRiskGateKey) {
        log("risk gate cleared", { key: lastRiskGateKey });
        lastRiskGateKey = "";
      }

      const tradedMarketIds = state.getTradedMarketIds();
      const activeContexts = activeTargets.map((target) => {
        const mergedCfg = withTargetOverrides(cfg, target);
        return {
          target,
          label: targetLabel(target),
          symbol: resolveSymbol(target),
          model: targetModels.get(target.id)!,
          mergedCfg,
          lookback: Math.max(80, mergedCfg.lookbackMinutes),
        };
      });

      const symbolMaxLookback = new Map<string, number>();
      for (const ctx of activeContexts) {
        const prev = symbolMaxLookback.get(ctx.symbol) ?? 0;
        if (ctx.lookback > prev) symbolMaxLookback.set(ctx.symbol, ctx.lookback);
      }
      const closesPromises = new Map<string, Promise<number[]>>();
      for (const [symbol, lookback] of symbolMaxLookback.entries()) {
        closesPromises.set(symbol, binance.getCloses(symbol, "1m", lookback));
      }

      const prepared = await Promise.all(activeContexts.map(async (ctx): Promise<PreparedOrder | null> => {
        const { target, label, model, symbol, mergedCfg } = ctx;
        try {
          const markets = await gamma.getCandidateMarketsForTarget(target, 500);
          const best = gamma.selectBestMarketForTarget(markets, target, new Date(), tradedMarketIds);
          if (!best) return null;

          if (!state.canTradeByCooldown(cfg.cooldownSeconds, target.id)) {
            log(`[${label}] skip: cooldown active (${cfg.cooldownSeconds}s)`);
            return null;
          }

          const windowCheck = isCurrentWindowByEnd(best.endDate, target.horizonMin);
          if (!windowCheck.ok) {
            log(`[${label}] skip: not current window`, {
              marketId: best.marketId,
              endDate: best.endDate,
              minsToEnd: Number.isFinite(windowCheck.minsToEnd) ? Number(windowCheck.minsToEnd.toFixed(3)) : null,
              alignDiffMs: Number.isFinite(windowCheck.alignDiffMs) ? Math.round(windowCheck.alignDiffMs) : null,
            });
            return null;
          }

          const closesAll = await closesPromises.get(symbol)!;
          const closes = closesAll.slice(-ctx.lookback);
          const pred = predictWithTrainedModel(closes, model);
          if (!pred) {
            log(`[${label}] skip: prediction failed`);
            return null;
          }

          const decision = makeDecision(pred, best, mergedCfg);
          if (decision.action === "SKIP" || !decision.side || !decision.tokenId || !decision.limitPrice || !decision.shareSize) {
            return null;
          }

          return {
            target,
            label,
            symbol,
            best,
            pred,
            decision: {
              side: decision.side,
              tokenId: decision.tokenId,
              limitPrice: decision.limitPrice,
              shareSize: decision.shareSize,
              edge: Number(decision.edge ?? 0),
            },
            entryRefPrice: closes[closes.length - 1],
          };
        } catch (targetErr) {
          log(`[${label}] loop error`, targetErr instanceof Error ? targetErr.message : targetErr);
          return null;
        }
      }));

      const readyOrders = prepared
        .filter((x): x is PreparedOrder => Boolean(x))
        .sort((a, b) => b.decision.edge - a.decision.edge);

      for (const order of readyOrders) {
        if (tradedMarketIds.has(order.best.marketId)) continue;
        if (!state.canTradeByCooldown(cfg.cooldownSeconds, order.target.id)) {
          log(`[${order.label}] skip: cooldown active (${cfg.cooldownSeconds}s)`);
          continue;
        }

        log(`[${order.label}] selected market`, {
          marketId: order.best.marketId,
          endDate: order.best.endDate,
          liquidity: order.best.liquidity,
          yesPrice: order.best.yesPrice,
          noPrice: order.best.noPrice,
        });
        log(`[${order.label}] prediction`, order.pred);
        log(`[${order.label}] decision`, order.decision);

        const response = await trader.placeBuyOrder({
          tokenId: order.decision.tokenId,
          price: order.decision.limitPrice,
          size: order.decision.shareSize,
          tickSize: order.best.tickSize,
          negRisk: order.best.negRisk,
        });

        log(`[${order.label}] order response`, response);
        state.recordTrade({
          marketId: order.best.marketId,
          targetId: order.target.id,
          coin: order.target.coin,
          horizonMin: order.target.horizonMin,
          symbol: order.symbol,
          side: order.decision.side,
          entryTime: new Date().toISOString(),
          settleTime: order.best.endDate,
          entryRefPrice: order.entryRefPrice,
          resolved: false,
          orderId: response?.orderID ? String(response.orderID) : undefined,
        });
        tradedMarketIds.add(order.best.marketId);
      }
    } catch (err) {
      log("main loop error", err instanceof Error ? err.message : err);
    } finally {
      await sleep((runtime?.cfg.pollIntervalSec ?? 20) * 1000);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  startBot().catch((err) => {
    console.error("fatal error", err);
    process.exit(1);
  });
}
