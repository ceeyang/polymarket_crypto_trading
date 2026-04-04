import { Wallet } from "ethers";
import type { MarketTarget, Config } from "../config.js";

/**
 * 为目标生成唯一标识符 (例如: BTC_5m)
 */
export function targetLabel(t: MarketTarget): string {
  return `${t.coin}_${t.horizonMin}m`;
}

/**
 * 确定目标对应的显示 Symbol (例如: BTC or ETH)
 */
export function resolveSymbol(target: MarketTarget): string {
  return (target.symbol || `${target.coin}USDT`).toUpperCase();
}

/**
 * 检查当前时间是否位于盘口结算前的目标窗口内 (例如: 5分钟线最后阶段)
 */
export function isCurrentWindowByEnd(endDate: string, horizonMin: number, nowMs = Date.now()): { ok: boolean; minsToEnd: number; alignDiffMs: number } {
  const endMs = Date.parse(endDate);
  if (!Number.isFinite(endMs)) {
    return { ok: false, minsToEnd: Number.NaN, alignDiffMs: Number.NaN };
  }
  const intervalMs = horizonMin * 60_000;
  const expectedEndMs = Math.floor(nowMs / intervalMs) * intervalMs + intervalMs;
  const alignDiffMs = Math.abs(endMs - expectedEndMs);
  const minsToEnd = (endMs - nowMs) / 60000;
  
  // 5分钟线通常在每5分钟整点结束，允许 ±15s 的对齐偏差
  const ok = minsToEnd > 0 && alignDiffMs <= 15_000;
  return { ok, minsToEnd, alignDiffMs };
}

/**
 * 计算当前窗口的理论开始时间 (用于审计追踪)
 */
export function cycleStartInfo(
  endDate: string, 
  horizonMin: number, 
  nowMs = Date.now()
): { startMs: number; elapsedSec: number; remainingSec: number } | null {
  const endMs = Date.parse(endDate);
  if (!Number.isFinite(endMs)) return null;
  const cycleMs = horizonMin * 60_000;
  const startMs = endMs - cycleMs;
  return {
    startMs,
    elapsedSec: Math.max(0, (nowMs - startMs) / 1000),
    remainingSec: Math.max(0, (endMs - nowMs) / 1000),
  };
}

/**
 * 计算该目标的评估锁定过期时间 (防止一轮内多次评估同一盘口)
 * 通常锁定到盘口结算时间点
 */
export function cycleLockExpireMs(endDate: string): number {
  const settleMs = Date.parse(endDate);
  if (Number.isFinite(settleMs) && settleMs > 0) return settleMs;
  return Date.now() + 15 * 60_000;
}

/**
 * 生成预测审计记录的唯一 ID
 */
export function predictionAuditId(targetId: string, marketId: string): string {
  return `${Date.now()}_${targetId}_${marketId}`;
}

/**
 * 应用特定的目标配置覆盖 (Target Overrides)
 */
export function withTargetOverrides(cfg: Config, target: MarketTarget): Config {
  return {
    ...cfg,
    ...(target.overrides || {})
  };
}

/**
 * 选取用户交易地址 (优先 funderAddress, 否则从 privateKey 推导)
 */
export function pickUserAddress(cfg: Config): string | null {
  if (cfg.funderAddress && cfg.funderAddress.trim()) return cfg.funderAddress.trim();
  if (!cfg.privateKey) return null;
  try {
    return new Wallet(cfg.privateKey).address;
  } catch {
    return null;
  }
}

/**
 * 清理过期的周期锁 (Cycle Locks)
 */
export function pruneExpiredCycleLocks(locks: Map<string, number>, nowMs = Date.now()): void {
  for (const [key, expireMs] of locks.entries()) {
    if (nowMs >= expireMs) {
      locks.delete(key);
    }
  }
}
