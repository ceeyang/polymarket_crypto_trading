import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_TARGETS, loadConfig } from "./config.js";
import { GammaClient } from "./clients/gamma.js";
import { PolymarketTrader } from "./clients/polymarket.js";
import { 
  resolveBotControlMode, 
  readConfigKey, 
  readReloadToken 
} from "./services/bot-control.js";
import { StateStore } from "./services/state-store.js";
import { 
  StartBotOptions, 
  RuntimeContext 
} from "./types.js";
import { 
  sleep, 
} from "./utils.js";
import { RealtimePriceService } from "./services/realtime-price.js";
import { logInfo, logError } from "./services/logger.js";
import { 
  resolveSymbol,
  targetLabel 
} from "./services/market-utils.js";
import { TradingEngine } from "./services/trading-engine.js";

const AUTO_CLAIM_MAX_RUNTIME_MS = Math.max(
  60_000,
  Math.floor(Number(process.env.AUTO_CLAIM_MAX_RUNTIME_MS || 10 * 60_000)),
);
const LIVE_SYNC_MAX_CHECKS = Math.max(
  10,
  Math.floor(Number(process.env.LIVE_SYNC_MAX_CHECKS || 80)),
);

async function buildRuntimeContext(cfgKey: string, reloadToken: number, oldPriceService?: RealtimePriceService): Promise<RuntimeContext> {
  const cfg = loadConfig();
  const gamma = new GammaClient(cfg);
  const trader = await PolymarketTrader.create(cfg);

  const priceService = oldPriceService ?? new RealtimePriceService(cfg);
  if (!oldPriceService) {
    await priceService.start();
  }

  const enabledTargets = cfg.targets.filter((x) => x.enabled).slice(0, MAX_TARGETS);
  if (enabledTargets.length === 0) {
    throw new Error("No enabled targets in config.strategy.targets");
  }

  return {
    cfg,
    cfgKey,
    reloadToken,
    gamma,
    trader,
    priceService,
    activeTargets: enabledTargets,
  };
}

export async function startBot(options?: StartBotOptions): Promise<void> {
  const controlMode = options?.controlMode ?? resolveBotControlMode(process.env.BOT_CONTROL_MODE);
  const state = new StateStore();
  const sessionStartedAt = new Date().toISOString();
  const targetAnalysisLocks = new Map<string, number>();

  const engine = new TradingEngine(
    state,
    targetAnalysisLocks,
    sessionStartedAt,
    AUTO_CLAIM_MAX_RUNTIME_MS,
    LIVE_SYNC_MAX_CHECKS
  );

  let runtime: RuntimeContext | null = null;

  const reloadRuntime = async (reason: string): Promise<RuntimeContext> => {
    const cfgKey = readConfigKey();
    const reloadToken = readReloadToken();
    if (runtime && runtime.cfgKey === cfgKey && runtime.reloadToken === reloadToken) {
      return runtime;
    }

    try {
      const next = await buildRuntimeContext(cfgKey, reloadToken, runtime?.priceService);
      const isStartup = runtime == null;
      runtime = next;

      if (isStartup) {
        logInfo(`bot started dryRun=${next.cfg.dryRun} interval=${next.cfg.pollIntervalSec}s targets=${next.activeTargets.length} controlMode=${controlMode}`, {}, "system");
        logInfo(`session started at ${sessionStartedAt}`, {}, "system");
      } else {
        logInfo("runtime reloaded", {
          reason,
          dryRun: next.cfg.dryRun,
          targets: next.activeTargets.length,
          controlMode,
        }, "system");
      }
      
      logInfo("active targets", next.activeTargets.map((x) => ({
        id: x.id,
        coin: x.coin,
        horizonMin: x.horizonMin,
        symbol: resolveSymbol(x),
      })), "system");

      return next;
    } catch (err) {
      if (!runtime) throw err;
      logError("runtime reload failed, keep previous config", err instanceof Error ? err.message : err, "system");
      return runtime;
    }
  };

  runtime = await reloadRuntime("startup");

  while (true) {
    try {
      const currentRuntime = await reloadRuntime("round_begin");
      await engine.executeCycle(currentRuntime, controlMode);
    } catch (err) {
      logError("main loop error", err instanceof Error ? err.message : err, "system");
    } finally {
      const sleepSec = runtime?.cfg?.pollIntervalSec || 10;
      await sleep(sleepSec * 1000);
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
