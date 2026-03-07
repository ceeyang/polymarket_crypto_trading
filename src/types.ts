export type SideName = "YES" | "NO";

export interface GammaToken {
  token_id?: string;
  tokenId?: string;
  outcome?: string;
}

export interface GammaMarket {
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
  liquidity: number;
  yesTokenId: string;
  noTokenId: string;
  yesPrice: number;
  noPrice: number;
  tickSize: number;
  negRisk: boolean;
  score: number;
}

export interface Prediction {
  probUp: number;
  confidence: number;
  modelScore: number;
}

export interface TradeDecision {
  action: "BUY" | "SKIP";
  reason: string;
  side?: SideName;
  tokenId?: string;
  limitPrice?: number;
  usdSize?: number;
  shareSize?: number;
  edge?: number;
}

export interface BotState {
  tradedMarkets: Record<string, string>;
  lastTradeAt?: string;
}
