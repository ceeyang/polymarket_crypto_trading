import axios from "axios";
import type { Config } from "../config.js";
import { normalizeConditionId } from "../utils.js";
import { parseGammaSettlement, type GammaSettlementParse } from "./settlement-parser.js";

export interface ClosedPositionSnapshot {
  marketId: string | null;
  conditionId: string;
  pnlUsd: number | null;
  settlementPrice: number | null;
  outcomeText: string | null;
  closedAtMs: number;
  gamma: GammaSettlementParse;
}

function parseFinite(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * 获取已关闭的持仓列表并映射到 ConditionID 和 MarketID
 */
export async function fetchClosedPositionsMap(
  cfg: Config,
  user: string,
): Promise<{ byCondition: Map<string, ClosedPositionSnapshot>; byMarketId: Map<string, ClosedPositionSnapshot> }> {
  const endpoints = [
    { path: "/closed-positions", params: { user, size: 1000 } },
    { path: "/closed_positions", params: { user, size: 1000 } },
    { path: "/positions", params: { user, size: 1000, closed: true } },
  ];

  let rows: any[] = [];
  for (const ep of endpoints) {
    try {
      const { data } = await axios.get(`${cfg.dataApiHost}${ep.path}`, {
        params: ep.params,
        timeout: 20_000,
      });
      const arr = Array.isArray(data) ? data : ((data as any)?.data && Array.isArray((data as any).data) ? (data as any).data : []);
      if (Array.isArray(arr) && arr.length > 0) {
        rows = arr;
        break;
      }
    } catch {
      continue;
    }
  }

  const byCondition = new Map<string, ClosedPositionSnapshot>();
  const byMarketId = new Map<string, ClosedPositionSnapshot>();
  
  for (const r of rows) {
    const conditionId = normalizeConditionId(r?.conditionId ?? r?.condition_id ?? r?.condition);
    if (!conditionId) continue;
    
    const marketRaw = r?.marketId ?? r?.market_id ?? r?.market ?? r?.id;
    const marketId = marketRaw == null ? null : String(marketRaw).trim();

    const closedAtMs = Date.parse(
      String(
        r?.closedAt 
        ?? r?.closed_at 
        ?? r?.settledAt 
        ?? r?.settled_at 
        ?? r?.timestamp 
        ?? r?.updatedAt 
        ?? r?.updated_at 
        ?? 0
      )
    );

    const pnlUsd = parseFinite(
      r?.realizedPnl
      ?? r?.realized_pnl
      ?? r?.pnl
      ?? r?.profit
      ?? r?.usdPnl
      ?? r?.usdcPnl
      ?? r?.officialPnlUsd // 补充字段
    );

    const gamma = parseGammaSettlement(r);
    const snap: ClosedPositionSnapshot = { 
      marketId, 
      conditionId, 
      pnlUsd,
      settlementPrice: gamma.winnerPrice,
      outcomeText: gamma.winnerLabel,
      closedAtMs, 
      gamma 
    };

    byCondition.set(conditionId, snap);
    if (marketId) {
      byMarketId.set(marketId, snap);
    }
  }

  return { byCondition, byMarketId };
}

/**
 * 获取活跃持仓列表
 */
export async function fetchActivePositions(cfg: Config, user: string): Promise<any[]> {
  try {
    const { data } = await axios.get(`${cfg.dataApiHost}/positions`, {
      params: { user, size: 500 },
      timeout: 15000,
    });
    return Array.isArray(data) ? data : (data?.data && Array.isArray(data.data) ? data.data : []);
  } catch {
    return [];
  }
}
