export type SideName = "YES" | "NO";

export interface GammaToken {
  token_id?: string;
  tokenId?: string;
  outcome?: string;
}

export interface GammaMarket {
  [key: string]: unknown;
  id: string;
  conditionId?: string;
  question?: string;
  title?: string;
  description?: string;
  slug?: string;
  category?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  enableOrderBook?: boolean;
  endDate?: string;
  liquidity?: string | number;
  volume?: string | number;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  clobTokenIds?: string | string[];
  tokens?: GammaToken[];
  negRisk?: boolean;
  orderPriceMinTickSize?: number;
}

export interface SelectedMarket {
  marketId: string;
  conditionId: string;
  title: string;
  endDate: string;
  minsLeft: number;
  liquidity: number;
  yesTokenId: string;
  noTokenId: string;
  yesPrice: number;
  noPrice: number;
  tickSize: number;
  negRisk: boolean;
  score: number;
}

export interface StrategyExecutionMeta {
  mode: "DUAL_SIDE_OPENING";
  marketStartTime: string;
  marketEndTime: string;
  orderPrice: number;
  orderShareSize: number;
  plannedNotionalPerSideUsd: number;
  plannedTotalNotionalUsd: number;
  sides: SideName[];
}

export interface LiveTradeRecord {
  marketId: string;
  conditionId?: string;
  marketTitle?: string;
  targetId?: string;
  coin?: string;
  horizonMin?: number;
  symbol?: string;
  side: SideName;
  executionMode?: "LIVE" | "DRY_RUN";
  entryTime: string;
  settleTime: string;
  entryRefPrice: number;
  entryPrice?: number;
  entryNotionalUsd?: number;
  resolved?: boolean;
  win?: boolean;
  settleRefPrice?: number;
  orderId?: string;
  matchedSize?: number;
  orderStatus?: string;
  officialPnlUsd?: number;
  settlementSource?: "BINANCE_PROXY" | "POLYMARKET_OFFICIAL" | "POLYMARKET_MARK_PRICE";
}

export interface PredictionAuditRecord {
  id: string;
  createdAt: string;
  targetId: string;
  coin: string;
  symbol: string;
  horizonMin: number;
  marketId: string;
  marketTitle: string;
  decisionAction: "BUY" | "SKIP";
  decisionReason: string;
  strategyMeta?: StrategyExecutionMeta;
}

export interface BotState {
  tradedMarkets: Record<string, string>;
  lastTradeAt?: string;
  trades?: LiveTradeRecord[];
  predictions?: PredictionAuditRecord[];
}
