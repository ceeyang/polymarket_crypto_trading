export type SideName = "YES" | "NO";
export type PredictionDirection = "UP" | "DOWN" | "ABSTAIN";

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

export interface Prediction {
  direction: PredictionDirection;
  probUp: number;
  confidence: number;
  tradeable: boolean;
  providerIds: string[];
  providerLabel?: string;
  summary?: string;
  reasons?: string[];
  risks?: string[];
}

export interface ProviderRequestMetadata {
  submittedAt: string;
  apiType: "openai_responses" | "openai_chat_compatible";
  baseUrl: string;
  endpoint: "/responses" | "/chat/completions";
  model: string;
  responseMode: "json_schema" | "json_object";
  timeoutMs: number;
  temperature?: number;
  maxOutputTokens: number;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  systemPromptChars: number;
  userPromptChars: number;
  factsJsonChars: number;
  factTimestampUtc: string;
  marketId: string;
  promptPreview: {
    system: string;
    user: string;
  };
}

export interface ProviderPredictionReport {
  providerId: string;
  providerLabel: string;
  model: string;
  requestMeta?: ProviderRequestMetadata;
  direction?: PredictionDirection;
  probUp?: number;
  confidence?: number;
  tradeable?: boolean;
  summary?: string;
  reasons?: string[];
  risks?: string[];
  rawText?: string;
  latencyMs?: number;
  error?: string;
}

export interface PredictionFactPack {
  timestampUtc: string;
  coin: string;
  symbol: string;
  horizonMin: number;
  market: {
    marketId: string;
    conditionId: string;
    title: string;
    endDate: string;
    minsLeft: number;
    liquidity: number;
    yesPrice: number;
    noPrice: number;
    tickSize: number;
    fixedOrderPrice: number;
  };
  price: {
    last: number;
    changePct: {
      m1: number | null;
      m3: number | null;
      m5: number | null;
      m15: number | null;
      m30: number | null;
      m60: number | null;
    };
    rangePct: {
      m5: number | null;
      m15: number | null;
      m30: number | null;
    };
    realizedVolPct: {
      m5: number | null;
      m15: number | null;
      m30: number | null;
    };
    volumeRatio: {
      m5Over30: number | null;
      m15Over60: number | null;
    };
    recentCloses: number[];
  };
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
  aiDirection?: PredictionDirection;
  aiProbUp?: number;
  aiConfidence?: number;
  aiProviderIds?: string[];
  aiSummary?: string;
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
  aggregate: Prediction;
  facts: PredictionFactPack;
  providerReports: ProviderPredictionReport[];
}

export interface BotState {
  tradedMarkets: Record<string, string>;
  lastTradeAt?: string;
  trades?: LiveTradeRecord[];
  predictions?: PredictionAuditRecord[];
}
