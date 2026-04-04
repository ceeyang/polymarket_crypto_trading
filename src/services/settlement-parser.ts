import { parseStringArray, parseNumberArray } from "../utils.js";

export interface GammaSettlementParse {
  resolved: boolean;
  winnerIdx: number | null;
  winnerLabel: string | null;
  winnerPrice: number | null;
  outcomes: string[];
}

/**
 * 查找 Outcome 索引 (通过关键字匹配)
 */
export function findOutcomeIdx(outcomes: string[], keywords: string[]): number {
  for (let i = 0; i < outcomes.length; i += 1) {
    const s = outcomes[i]?.toLowerCase?.() ?? "";
    if (!s) continue;
    if (keywords.some((k) => s.includes(k))) return i;
  }
  return -1;
}

/**
 * 将 YES/NO 映射到盘口的 Outcomes 数组索引
 */
export function sideToOutcomeIdx(side: "YES" | "NO", outcomes: string[]): number | null {
  if (!outcomes.length) return null;
  let yesIdx = findOutcomeIdx(outcomes, ["yes", "up", "higher", "above", "win", "true"]);
  let noIdx = findOutcomeIdx(outcomes, ["no", "down", "lower", "below", "lose", "false"]);

  if (yesIdx < 0 && noIdx >= 0 && outcomes.length === 2) {
    yesIdx = noIdx === 0 ? 1 : 0;
  }
  if (noIdx < 0 && yesIdx >= 0 && outcomes.length === 2) {
    noIdx = yesIdx === 0 ? 1 : 0;
  }
  if (yesIdx < 0 || noIdx < 0 || yesIdx === noIdx) return null;
  return side === "YES" ? yesIdx : noIdx;
}

/**
 * 解析 Gamma 接口返回的市场结算信息
 */
export function parseGammaSettlement(row: any): GammaSettlementParse {
  const outcomes = parseStringArray(row?.outcomes);
  const prices = parseNumberArray(
    row?.outcomePrices
    ?? row?.outcome_prices
    ?? row?.resolutionPrices
    ?? row?.resolution_prices
    ?? row?.finalOutcomePrices
    ?? row?.final_outcome_prices,
  );

  const explicitWinnerIdxRaw =
    row?.winningOutcomeIndex
    ?? row?.winning_outcome_index
    ?? row?.winnerIndex
    ?? row?.winner_index;
  const explicitWinnerIdx = Number(explicitWinnerIdxRaw);
  if (Number.isInteger(explicitWinnerIdx) && explicitWinnerIdx >= 0) {
    const idx = explicitWinnerIdx;
    const winnerLabel = idx < outcomes.length ? outcomes[idx] : null;
    const winnerPrice = idx < prices.length ? prices[idx] : null;
    return { resolved: true, winnerIdx: idx, winnerLabel, winnerPrice, outcomes };
  }

  const explicitWinnerTextRaw =
    row?.winningOutcome
    ?? row?.winning_outcome
    ?? row?.winner
    ?? row?.resolvedOutcome
    ?? row?.resolved_outcome
    ?? row?.result;
  if (typeof explicitWinnerTextRaw === "string" && explicitWinnerTextRaw.trim()) {
    const winnerText = explicitWinnerTextRaw.trim().toLowerCase();
    const idx = outcomes.findIndex((x) => x.toLowerCase() === winnerText || x.toLowerCase().includes(winnerText));
    if (idx >= 0) {
      const winnerPrice = idx < prices.length ? prices[idx] : null;
      return { resolved: true, winnerIdx: idx, winnerLabel: outcomes[idx], winnerPrice, outcomes };
    }
    return { resolved: true, winnerIdx: null, winnerLabel: explicitWinnerTextRaw, winnerPrice: null, outcomes };
  }

  if (prices.length > 0) {
    let bestIdx = -1;
    let best = -Infinity;
    let second = -Infinity;
    for (let i = 0; i < prices.length; i += 1) {
      const p = prices[i];
      if (p > best) {
        second = best;
        best = p;
        bestIdx = i;
      } else if (p > second) {
        second = p;
      }
    }
    if (bestIdx >= 0) {
      const confidentlyResolved = best >= 0.999 || (best - Math.max(second, 0)) >= 0.98;
      if (confidentlyResolved) {
        const winnerLabel = bestIdx < outcomes.length ? outcomes[bestIdx] : null;
        return { resolved: true, winnerIdx: bestIdx, winnerLabel, winnerPrice: best, outcomes };
      }
    }
  }

  const status = String(row?.umaResolutionStatus ?? row?.uma_resolution_status ?? "").toLowerCase();
  const isResolvedByStatus = status === "resolved" || status === "finalized" || status === "settled";
  if (isResolvedByStatus) {
    return { resolved: true, winnerIdx: null, winnerLabel: null, winnerPrice: null, outcomes };
  }
  return { resolved: false, winnerIdx: null, winnerLabel: null, winnerPrice: null, outcomes };
}

/**
 * 判断特定 Side (YES/NO) 是否为胜利方向
 */
export function parseOutcomeWin(side: "YES" | "NO", raw: string): boolean | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const yesTokens = ["yes", "up", "higher", "above", "win", "won", "true", "1"];
  const noTokens = ["no", "down", "lower", "below", "lose", "lost", "false", "0"];
  if (yesTokens.some((x) => s.includes(x))) return side === "YES";
  if (noTokens.some((x) => s.includes(x))) return side === "NO";
  return null;
}
