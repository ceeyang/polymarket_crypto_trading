import axios from "axios";

import type { Config, ResolvedAiProviderConfig } from "../config.js";
import type {
  Prediction,
  PredictionDirection,
  PredictionFactPack,
  ProviderPredictionReport,
  ProviderRequestMetadata,
} from "../types.js";

const PREDICTION_SCHEMA = {
  name: "market_prediction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      direction: {
        type: "string",
        enum: ["UP", "DOWN", "ABSTAIN"],
      },
      probUp: {
        type: "number",
        minimum: 0,
        maximum: 1,
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
      },
      tradeable: {
        type: "boolean",
      },
      summary: {
        type: "string",
      },
      reasons: {
        type: "array",
        items: { type: "string" },
      },
      risks: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["direction", "probUp", "confidence", "tradeable", "summary", "reasons", "risks"],
  },
} as const;

interface RawPredictionPayload {
  direction?: unknown;
  probUp?: unknown;
  confidence?: unknown;
  tradeable?: unknown;
  summary?: unknown;
  reasons?: unknown;
  risks?: unknown;
}

export interface AiPredictionResult {
  aggregate: Prediction;
  providerReports: ProviderPredictionReport[];
  renderedPrompt: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function uniqStrings(values: string[], max = 6): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function coerceStringList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return uniqStrings(raw.map((x) => String(x)));
  }
  if (typeof raw === "string") {
    const text = raw.trim();
    return text ? [text] : [];
  }
  return [];
}

function truncateText(raw: string, maxChars: number): string {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildRequestMeta(
  provider: ResolvedAiProviderConfig,
  facts: PredictionFactPack,
  factsJson: string,
  systemPrompt: string,
  userPrompt: string,
): ProviderRequestMetadata {
  return {
    submittedAt: new Date().toISOString(),
    apiType: provider.apiType,
    baseUrl: provider.baseUrl.replace(/\/+$/, ""),
    endpoint: provider.apiType === "openai_chat_compatible" ? "/chat/completions" : "/responses",
    model: provider.model,
    responseMode: provider.responseMode,
    timeoutMs: provider.timeoutMs,
    temperature: provider.temperature,
    maxOutputTokens: provider.maxOutputTokens,
    reasoningEffort: provider.reasoningEffort,
    systemPromptChars: systemPrompt.length,
    userPromptChars: userPrompt.length,
    factsJsonChars: factsJson.length,
    factTimestampUtc: facts.timestampUtc,
    marketId: facts.market.marketId,
    promptPreview: {
      system: truncateText(systemPrompt, 280),
      user: truncateText(userPrompt, 560),
    },
  };
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_all, key) => vars[key] ?? "");
}

function flattenTextParts(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => flattenTextParts(item)).filter(Boolean).join("\n");
  }
  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  const candidates = [obj.text, obj.output_text, obj.content, obj.value];
  for (const candidate of candidates) {
    const text = flattenTextParts(candidate);
    if (text) return text;
  }
  return "";
}

function parseResponseJson(payload: any): { parsed: RawPredictionPayload; rawText: string } {
  if (payload && typeof payload.output_parsed === "object" && payload.output_parsed) {
    return {
      parsed: payload.output_parsed as RawPredictionPayload,
      rawText: JSON.stringify(payload.output_parsed),
    };
  }

  const candidates: unknown[] = [
    payload?.output_text,
    payload?.choices?.[0]?.message?.content,
    payload?.output,
  ];

  for (const candidate of candidates) {
    const text = flattenTextParts(candidate).trim();
    if (!text) continue;
    try {
      return {
        parsed: JSON.parse(text) as RawPredictionPayload,
        rawText: text,
      };
    } catch {
      continue;
    }
  }

  throw new Error("provider response did not contain parseable JSON");
}

function normalizePredictionPayload(
  provider: ResolvedAiProviderConfig,
  requestMeta: ProviderRequestMetadata,
  payload: RawPredictionPayload,
  rawText: string,
  latencyMs: number,
): ProviderPredictionReport {
  const probUp = clamp(Number(payload.probUp), 0, 1);
  const confidence = clamp(Number(payload.confidence), 0, 1);
  const rawDirection = String(payload.direction || "").trim().toUpperCase();
  const direction: PredictionDirection = rawDirection === "UP" || rawDirection === "DOWN" || rawDirection === "ABSTAIN"
    ? rawDirection
    : (probUp >= 0.53 ? "UP" : probUp <= 0.47 ? "DOWN" : "ABSTAIN");
  const tradeable = Boolean(payload.tradeable) && direction !== "ABSTAIN";
  const reasons = coerceStringList(payload.reasons);
  const risks = coerceStringList(payload.risks);
  const summary = String(payload.summary || "").trim() || reasons[0] || risks[0] || "";

  return {
    providerId: provider.id,
    providerLabel: provider.label,
    model: provider.model,
    requestMeta,
    direction,
    probUp: Number(probUp.toFixed(6)),
    confidence: Number(confidence.toFixed(6)),
    tradeable,
    summary,
    reasons: uniqStrings(reasons),
    risks: uniqStrings(risks),
    rawText,
    latencyMs,
  };
}

function buildAggregatePrediction(reports: ProviderPredictionReport[]): Prediction {
  const valid = reports.filter((report) => !report.error && report.probUp != null && report.confidence != null);
  if (!valid.length) {
    throw new Error("all provider predictions failed");
  }

  const report = valid[0];
  const direction: PredictionDirection = report.direction ?? (
    Number(report.probUp) >= 0.53 ? "UP" : Number(report.probUp) <= 0.47 ? "DOWN" : "ABSTAIN"
  );
  const tradeable = direction !== "ABSTAIN" && Boolean(report.tradeable);
  const summary = report.summary || "";
  const reasons = uniqStrings(report.reasons ?? []);
  const risks = uniqStrings(report.risks ?? []);
  const providerIds = [report.providerId];

  return {
    direction,
    probUp: Number(Number(report.probUp).toFixed(6)),
    confidence: Number(Number(report.confidence).toFixed(6)),
    tradeable,
    providerIds,
    providerLabel: report.providerLabel,
    summary,
    reasons,
    risks,
  };
}

async function callOpenAIResponses(
  provider: ResolvedAiProviderConfig,
  requestMeta: ProviderRequestMetadata,
  systemPrompt: string,
  userPrompt: string,
): Promise<ProviderPredictionReport> {
  const startedAt = Date.now();
  try {
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    const response = await axios.post(
      `${baseUrl}/responses`,
      {
        model: provider.model,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: userPrompt }],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            ...PREDICTION_SCHEMA,
          },
        },
        max_output_tokens: provider.maxOutputTokens,
        reasoning: provider.reasoningEffort ? { effort: provider.reasoningEffort } : undefined,
      },
      {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: provider.timeoutMs,
      },
    );
    const { parsed, rawText } = parseResponseJson(response.data);
    return normalizePredictionPayload(provider, requestMeta, parsed, rawText, Date.now() - startedAt);
  } catch (err) {
    return {
      providerId: provider.id,
      providerLabel: provider.label,
      model: provider.model,
      requestMeta,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - startedAt,
    };
  }
}

async function callOpenAIChatCompatible(
  provider: ResolvedAiProviderConfig,
  requestMeta: ProviderRequestMetadata,
  systemPrompt: string,
  userPrompt: string,
): Promise<ProviderPredictionReport> {
  const startedAt = Date.now();
  try {
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    const responseFormat = provider.responseMode === "json_object"
      ? { type: "json_object" }
      : {
          type: "json_schema",
          json_schema: PREDICTION_SCHEMA,
        };

    const response = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model: provider.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: provider.temperature,
        max_tokens: provider.maxOutputTokens,
        response_format: responseFormat,
      },
      {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: provider.timeoutMs,
      },
    );
    const { parsed, rawText } = parseResponseJson(response.data);
    return normalizePredictionPayload(provider, requestMeta, parsed, rawText, Date.now() - startedAt);
  } catch (err) {
    return {
      providerId: provider.id,
      providerLabel: provider.label,
      model: provider.model,
      requestMeta,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - startedAt,
    };
  }
}

async function callProvider(
  provider: ResolvedAiProviderConfig,
  requestMeta: ProviderRequestMetadata,
  systemPrompt: string,
  userPrompt: string,
): Promise<ProviderPredictionReport> {
  if (!provider.apiKey) {
    return {
      providerId: provider.id,
      providerLabel: provider.label,
      model: provider.model,
      requestMeta,
      error: `missing API key env: ${provider.apiKeyEnvVar}`,
    };
  }
  if (!provider.model) {
    return {
      providerId: provider.id,
      providerLabel: provider.label,
      model: provider.model,
      requestMeta,
      error: "model is required",
    };
  }
  if (!provider.baseUrl) {
    return {
      providerId: provider.id,
      providerLabel: provider.label,
      model: provider.model,
      requestMeta,
      error: "baseUrl is required",
    };
  }
  if (provider.apiType === "openai_chat_compatible") {
    return callOpenAIChatCompatible(provider, requestMeta, systemPrompt, userPrompt);
  }
  return callOpenAIResponses(provider, requestMeta, systemPrompt, userPrompt);
}

export async function predictWithProviders(
  cfg: Config,
  facts: PredictionFactPack,
): Promise<AiPredictionResult> {
  const factsJson = JSON.stringify(facts, null, 2);
  const vars = {
    coin: facts.coin,
    symbol: facts.symbol,
    horizonMin: String(facts.horizonMin),
    factsJson,
  };
  const renderedPrompt = renderTemplate(cfg.userPromptTemplate, vars);
  const requestMeta = buildRequestMeta(cfg.provider, facts, factsJson, cfg.systemPrompt, renderedPrompt);
  const providerReports = [await callProvider(cfg.provider, requestMeta, cfg.systemPrompt, renderedPrompt)];

  const aggregate = buildAggregatePrediction(providerReports);
  return {
    aggregate,
    providerReports,
    renderedPrompt,
  };
}
