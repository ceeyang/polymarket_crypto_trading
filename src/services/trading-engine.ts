import fs from "node:fs";
import path from "node:path";
import { Config, MarketTarget, MAX_TARGETS } from "../config.js";
import { GammaClient } from "../clients/gamma.js";
import { PolymarketTrader } from "../clients/polymarket.js";
import { StateStore } from "./state-store.js";
import { RealtimePriceService, TokenPrice } from "./realtime-price.js";
import { 
  SelectedMarket, 
  SideName, 
  PredictionAuditRecord, 
  RuntimeContext,
  BotControlMode 
} from "../types.js";
import { 
  isCurrentWindowByEnd, 
  cycleStartInfo, 
  cycleLockExpireMs, 
  predictionAuditId, 
  withTargetOverrides,
  targetLabel,
  resolveSymbol,
  pruneExpiredCycleLocks
} from "./market-utils.js";
import { 
  sleep,
} from "../utils.js";
import { 
  syncLiveOrdersAndCancelStale, 
  settleLiveTradesWithOfficial,
  reconcileOrder 
} from "./order-service.js";
import { claimRedeemablePositions } from "./claim-service.js";
import { logInfo, logWarn, logError, logSuccess } from "./logger.js";
import { readBotControlState } from "./bot-control.js";

export interface PreparedOrder {
  target: MarketTarget;
  label: string;
  symbol: string;
  best: SelectedMarket;
  side: SideName;
  orderPlanIndex: number;
  tokenId: string;
  limitPrice: number;
  shareSize: number;
  entryRefPrice: number;
}

export interface PreparedEvaluation {
  audit: PredictionAuditRecord;
  best: SelectedMarket;
  orders: PreparedOrder[];
  cycleLockUntilMs: number;
}

export type AutoClaimRaceResult = 
  | { kind: "result"; summary: any }
  | { kind: "timeout" };

/**
 * 核心交易循环上下文（闭包状态）
 */
export class TradingEngine {
  private lastAutoClaimAtMs = 0;
  private autoClaimInFlight = false;
  private autoClaimRunSeq = 0;
  private cancelStaleInFlight = false;
  private lastScanEnabled: boolean | null = null;
  private liveSyncCursor = 0;
  private hwrEvaluatedMarkets = new Set<string>();
  private hwrWatchMap = new Map<string, { target: any, best: any, cfg: any }>();
  private lastSummaryKey = "";
  private hwrLogThrottle = new Set<string>();

  constructor(
    private readonly state: StateStore,
    private readonly targetAnalysisLocks: Map<string, number>,
    private readonly sessionStartedAt: string,
    private readonly AUTO_CLAIM_MAX_RUNTIME_MS: number,
    private readonly LIVE_SYNC_MAX_CHECKS: number
  ) {
    this.initClaimTime();
  }

  private initClaimTime() {
    try {
      const claimFile = path.resolve("state", "last_claim.txt");
      if (fs.existsSync(claimFile)) {
        this.lastAutoClaimAtMs = Number(fs.readFileSync(claimFile, "utf8").trim());
      }
      if (!Number.isFinite(this.lastAutoClaimAtMs) || this.lastAutoClaimAtMs <= 0) {
        this.lastAutoClaimAtMs = Date.now();
        this.saveClaimTime();
      }
    } catch {
      this.lastAutoClaimAtMs = Date.now();
      this.saveClaimTime();
    }
  }

  private saveClaimTime() {
    try {
      fs.mkdirSync(path.resolve("state"), { recursive: true });
      fs.writeFileSync(path.resolve("state", "last_claim.txt"), String(this.lastAutoClaimAtMs), "utf8");
    } catch { }
  }

  public async executeCycle(runtime: RuntimeContext, controlMode: BotControlMode): Promise<void> {
    const { cfg, gamma, trader, activeTargets } = runtime;
    pruneExpiredCycleLocks(this.targetAnalysisLocks);

    // ── 性能摘要更新 ──────────────────────────────────────────────────
    const perfMode = cfg.dryRun ? "DRY_RUN" : "LIVE";
    const perfAll = this.state.getPerformanceSummary(perfMode);
    const perfSession = this.state.getPerformanceSummarySince(this.sessionStartedAt, perfMode);
    const summaryPayload = {
      totalTrades: perfAll.totalTrades,
      settledTrades: perfAll.settledTrades,
      wins: perfAll.wins,
      winRate: Number((perfAll.winRate * 100).toFixed(2)),
      sessionTrades: perfSession.totalTrades,
      sessionSettledTrades: perfSession.settledTrades,
      sessionWins: perfSession.wins,
      sessionWinRate: Number((perfSession.winRate * 100).toFixed(2)),
      avgFillRate: Number((perfAll.avgFillRate * 100).toFixed(2)),
      totalPnLUsd: Number(perfAll.totalPnLUsd.toFixed(4)),
    };
    const summaryKey = JSON.stringify(summaryPayload);
    if (summaryKey !== this.lastSummaryKey) {
      logInfo("round summary", summaryPayload, "search-market");
      this.lastSummaryKey = summaryKey;
    }

    // ── 异步订单对账（补偿轮询，每 60s 运行一次） ────────────────────────
    const nowMs = Date.now();
    if (!cfg.dryRun && (nowMs % 60000 < 5000)) {
      const unresolvedTrades = (this.state.load().trades || [])
        .filter(t => t.executionMode === "LIVE" && t.orderId && !t.resolved)
        .filter(t => !["FILLED", "MATCHED", "CLOSED", "CANCELED", "EXPIRED", "REJECTED"].includes(String(t.orderStatus).toUpperCase()))
        .slice(-20);

      for (const t of unresolvedTrades) {
        if (t.orderId) {
          void reconcileOrder(this.state, trader, t.orderId, targetLabel({ coin: (t.coin as any), horizonMin: (t.horizonMin as any) } as any));
        }
      }
    }

    // ── 异步撤销过期挂单 ──────────────────────────────────────────────
    if (!this.cancelStaleInFlight && !cfg.dryRun) {
      this.cancelStaleInFlight = true;
      void (async () => {
        try {
          const liveSync = await syncLiveOrdersAndCancelStale(this.state, trader, {
            maxChecks: this.LIVE_SYNC_MAX_CHECKS,
            cursor: this.liveSyncCursor,
          });
          this.liveSyncCursor = liveSync.nextCursor;
          if (liveSync.updated > 0 || liveSync.canceled > 0 || liveSync.finalizedCanceled > 0) {
            logInfo("live order sync action", liveSync, "cancel-stale");
          }

          const official = await settleLiveTradesWithOfficial(cfg, this.state, 0);
          if (official.resolved > 0) {
            logInfo("official settlement synced", official, "settle");
          }
        } catch (err) {
          logError("sync error", err instanceof Error ? err.message : err, "cancel-stale");
        } finally {
          this.cancelStaleInFlight = false;
        }
      })();
    }

    // Dry-run 结算
    void settleLiveTradesWithOfficial(cfg, this.state, 0) // Reuse settleLive (actually should be rename to settleTradesByOfficial)
      .catch(() => {});

    // ── 异步领取收益 ──────────────────────────────────────────────────
    if (cfg.autoClaim && !cfg.dryRun && !this.autoClaimInFlight) {
      if (nowMs - this.lastAutoClaimAtMs >= cfg.claimIntervalSec * 1000) {
        this.autoClaimInFlight = true;
        this.lastAutoClaimAtMs = nowMs;
        this.saveClaimTime();
        
        const runId = ++this.autoClaimRunSeq;
        const startedAtMs = Date.now();
        logInfo("started", { runId, timeoutMs: this.AUTO_CLAIM_MAX_RUNTIME_MS }, "auto-claim");

        const claimPromise = claimRedeemablePositions(cfg, {
          logPrefix: "[auto-claim]",
          quietNoop: true,
          maxConcurrency: 3,
          logger: logInfo,
        });

        claimPromise.catch((err) => {
          logError("late error", { runId, error: err instanceof Error ? err.message : err }, "auto-claim");
        });

        void Promise.race<AutoClaimRaceResult>([
          claimPromise.then((summary) => ({ kind: "result" as const, summary })),
          sleep(this.AUTO_CLAIM_MAX_RUNTIME_MS).then(() => ({ kind: "timeout" as const })),
        ])
          .then((outcome) => {
            if (outcome.kind === "timeout") {
              logWarn("timed out", { runId, timeoutMs: this.AUTO_CLAIM_MAX_RUNTIME_MS, elapsedMs: Date.now() - startedAtMs }, "auto-claim");
              return;
            }
            if (outcome.summary.reason !== "no redeemable condition ids") {
              logSuccess("result", outcome.summary, "auto-claim");
            }
          })
          .catch((err) => {
            logError("auto-claim error", err instanceof Error ? err.message : err, "auto-claim");
          })
          .finally(() => {
            if (runId === this.autoClaimRunSeq) this.autoClaimInFlight = false;
          });
      }
    }

    // ── 策略扫描开关 ──────────────────────────────────────────────────
    const controlState = readBotControlState();
    const scanEnabled = controlMode === "STANDALONE" ? true : Boolean(controlState.scanningEnabled);
    if (scanEnabled !== this.lastScanEnabled) {
      logInfo("scan state updated", { controlMode, scanningEnabled: scanEnabled }, "system");
      this.lastScanEnabled = scanEnabled;
    }
    if (!scanEnabled) {
      this.hwrWatchMap.clear();
      return;
    }

    // ── WebSocket HWR 回调注册 ──────────────────────────────────────
    if (runtime.priceService) {
      runtime.priceService.onPriceUpdate = (price) => {
        this.executeHwrSprint(price, runtime, controlMode).catch(() => {});
      };

      // 实时扫描兜底
      if (cfg.hwrEnabled) {
        for (const [tokenId, context] of this.hwrWatchMap.entries()) {
          if (this.hwrEvaluatedMarkets.has(context.best.marketId)) continue;
          const cachedPrice = runtime.priceService.getPrice(tokenId);
          if (cachedPrice) {
            void this.executeHwrSprint(cachedPrice, runtime, controlMode);
          }
        }
      }
    }

    // ── 市场发现 & 双边对冲策略 ────────────────────────────────────────
    const tradedMarketIds = this.state.getTradedMarketIds();
    const targetDiscoveryMap = new Map<string, { best: SelectedMarket, target: MarketTarget }>();
    const tokensToWatch: string[] = [];

    if (cfg.dualSideEnabled || cfg.hwrEnabled) {
      for (const target of activeTargets) {
        if (this.targetAnalysisLocks.has(target.id)) continue;
        try {
          const markets = await gamma.getCandidateMarketsForTarget(target, 50);
          const best = gamma.selectBestMarketForTarget(markets, target, new Date(), tradedMarketIds);
          if (best) {
            targetDiscoveryMap.set(target.id, { best, target });
            const mergedCfg = withTargetOverrides(cfg, target);
            if (mergedCfg.hwrEnabled) {
              tokensToWatch.push(best.yesTokenId, best.noTokenId);
              this.hwrWatchMap.set(best.yesTokenId, { target, best, cfg: mergedCfg });
              this.hwrWatchMap.set(best.noTokenId, { target, best, cfg: mergedCfg });
            }
          }
        } catch (err) {
          logError(`[${targetLabel(target)}] discovery error`, err instanceof Error ? err.message : err, "search-market");
        }
      }
      if (runtime.priceService) {
        runtime.priceService.updateWatchedTokens(tokensToWatch);
        
        // 清理 hwrWatchMap 中不再需要的 Token
        const currentTokenSet = new Set(tokensToWatch);
        for (const tid of this.hwrWatchMap.keys()) {
          if (!currentTokenSet.has(tid)) {
            this.hwrWatchMap.delete(tid);
          }
        }
      }
    }

    // 执行双边对冲
    if (cfg.dualSideEnabled) {
      for (const [targetId, discovery] of targetDiscoveryMap.entries()) {
        const { best, target } = discovery;
        const mergedCfg = withTargetOverrides(cfg, target);
        
        const windowCheck = isCurrentWindowByEnd(best.endDate, target.horizonMin);
        if (!windowCheck.ok) continue;

        const startInfo = cycleStartInfo(best.endDate, target.horizonMin);
        if (!startInfo) continue;

        const orderEntries = mergedCfg.orderEntries
          .map((entry) => ({ price: Number(entry.price), shareSize: Number(entry.shareSize) }))
          .filter((entry) => Number.isFinite(entry.price) && entry.price > 0 && Number.isFinite(entry.shareSize) && entry.shareSize > 0);

        if (!orderEntries.length) continue;

        const audit: PredictionAuditRecord = {
          id: predictionAuditId(target.id, best.marketId),
          createdAt: new Date().toISOString(),
          targetId: target.id,
          coin: target.coin,
          symbol: resolveSymbol(target),
          horizonMin: target.horizonMin,
          marketId: best.marketId,
          marketTitle: best.title,
          decisionAction: "BUY",
          decisionReason: "dual-sided ladder orders",
          strategyMeta: {
            mode: "DUAL_SIDE_OPENING",
            marketStartTime: new Date(startInfo.startMs).toISOString(),
            marketEndTime: best.endDate,
            orderEntries: orderEntries.map(e => ({ ...e, plannedNotionalUsd: e.price * e.shareSize })),
            plannedOrderCount: orderEntries.length * 2,
            plannedNotionalPerSideUsd: orderEntries.reduce((s, e) => s + e.price * e.shareSize, 0),
            plannedTotalNotionalUsd: orderEntries.reduce((s, e) => s + e.price * e.shareSize, 0) * 2,
            sides: ["YES", "NO"],
          },
        };

        this.targetAnalysisLocks.set(target.id, cycleLockExpireMs(best.endDate));
        this.state.markMarketAttempt(best.marketId);
        tradedMarketIds.add(best.marketId);

        logInfo(`[${target.id}] selected market`, { marketId: best.marketId, title: best.title }, "search-market");

        for (const entry of orderEntries) {
          for (const side of ["YES" as const, "NO" as const]) {
            const tokenId = side === "YES" ? best.yesTokenId : best.noTokenId;
            const px = Number(entry.price.toFixed(6));
            
            trader.placeBuyOrder({
              tokenId,
              price: px,
              size: entry.shareSize,
              tickSize: best.tickSize,
              negRisk: best.negRisk,
            }).then((resp) => {
              const orderId = resp?.orderID || resp?.orderId || resp?.id;
              this.state.recordTrade({
                marketId: best.marketId,
                conditionId: best.conditionId,
                marketTitle: best.title,
                targetId: target.id,
                coin: target.coin,
                horizonMin: target.horizonMin,
                symbol: resolveSymbol(target),
                side,
                executionMode: cfg.dryRun ? "DRY_RUN" : "LIVE",
                entryTime: new Date().toISOString(),
                settleTime: best.endDate,
                entryRefPrice: side === "YES" ? best.yesPrice : best.noPrice,
                entryPrice: px,
                entryNotionalUsd: cfg.dryRun ? px * entry.shareSize : 0,
                orderId: orderId ? String(orderId) : undefined,
                orderStatus: String(resp?.status || (cfg.dryRun ? "DRY_RUN" : "OPEN")),
              });
            }).catch(e => logError("place order error", e, "place-order"));
          }
        }
      }
    }
  }

  private async executeHwrSprint(price: TokenPrice, runtime: RuntimeContext, controlMode: BotControlMode) {
    const context = this.hwrWatchMap.get(price.tokenId);
    if (!context) return;

    const dynamicControl = readBotControlState();
    const currentScanEnabled = controlMode === "STANDALONE" ? true : Boolean(dynamicControl.scanningEnabled);
    if (!currentScanEnabled) return;

    const { target, best } = context;
    if (this.hwrEvaluatedMarkets.has(best.marketId)) return;

    // Use current settings from runtime/target to avoid stale config
    const currentTarget = runtime.activeTargets.find(t => t.id === target.id) || target;
    const currentCfg = withTargetOverrides(runtime.cfg, currentTarget);
    
    if (!currentCfg.hwrEnabled) return;

    const endTimeMs = new Date(best.endDate).getTime();
    const secondsToSettle = (endTimeMs - Date.now()) / 1000;

    // 添加窗口监控日志 (每隔几秒输出一次避免过载)
    if (secondsToSettle > 0 && secondsToSettle <= currentCfg.hwrTriggerSeconds + 5) {
      const currentPx = price.bestAsk || price.mid;
      const inPriceRange = currentPx >= currentCfg.hwrMinPrice && currentPx <= currentCfg.hwrMaxPrice;
      const side = price.tokenId === best.yesTokenId ? "YES" : "NO";
      
      if (secondsToSettle <= currentCfg.hwrTriggerSeconds) {
        if (!inPriceRange) {
          const throttleKey = `${best.marketId}_${side}_out_range`;
          if (!this.hwrLogThrottle.has(throttleKey)) {
            logWarn(`[HWR-WS] In window but price OUT of range`, { 
              market: best.marketId, 
              side,
              px: currentPx, 
              range: [currentCfg.hwrMinPrice, currentCfg.hwrMaxPrice],
              rem: Math.floor(secondsToSettle)
            }, "high-win-rate");
            this.hwrLogThrottle.add(throttleKey);
          }
        }
      } else {
        // 即将进入窗口
        const throttleKey = `${best.marketId}_${side}_approaching`;
        if (!this.hwrLogThrottle.has(throttleKey)) {
          logInfo(`[HWR-WS] Approaching window`, {
            market: best.marketId,
            side,
            px: currentPx,
            rem: Math.floor(secondsToSettle)
          }, "high-win-rate");
          this.hwrLogThrottle.add(throttleKey);
        }
      }
      
      if (secondsToSettle > 0 && secondsToSettle <= currentCfg.hwrTriggerSeconds && inPriceRange) {
        this.hwrEvaluatedMarkets.add(best.marketId);
        this.hwrLogThrottle.clear(); // 触发后清理
        let size = Number((currentCfg.hwrFixedSizeUsd / currentPx).toFixed(2));
        if (size < 5) size = 5;

        logSuccess(`[HWR-WS] TRIGGER! Placing order`, { 
          market: best.marketId, 
          side, 
          px: currentPx,
          size
        }, "high-win-rate");

        runtime.trader.placeBuyOrder({
          tokenId: price.tokenId,
          price: currentPx,
          size,
          tickSize: best.tickSize,
          negRisk: best.negRisk,
        }).then((resp) => {
          const orderId = resp?.orderID || resp?.orderId || resp?.id;
          this.state.recordTrade({
            marketId: best.marketId,
            conditionId: best.conditionId,
            marketTitle: best.title,
            targetId: target.id,
            coin: target.coin,
            horizonMin: target.horizonMin,
            symbol: targetLabel(target),
            side: price.tokenId === best.yesTokenId ? "YES" : "NO",
            executionMode: currentCfg.dryRun ? "DRY_RUN" : "LIVE",
            entryTime: new Date().toISOString(),
            settleTime: best.endDate,
            entryRefPrice: currentPx,
            entryPrice: currentPx,
            entryNotionalUsd: currentCfg.dryRun ? currentPx * size : 0,
            orderId: orderId ? String(orderId) : undefined,
            orderStatus: String(resp?.status || (currentCfg.dryRun ? "DRY_RUN" : "OPEN")),
            strategyMeta: { mode: "HIGH_WIN_RATE_SPRINT" }
          });
        }).catch(e => logError("HWR-WS error", e, "high-win-rate"));
      }
    }
  }
}
