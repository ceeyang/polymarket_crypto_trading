import http from "node:http";
import { URL } from "node:url";
import axios from "axios";
import { loadConfig } from "../config.js";

const marketUrlCache = new Map<string, { ts: number; url: string }>();
const MARKET_URL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

export function sendText(res: http.ServerResponse, status: number, contentType: string, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.end(body);
}

export function redirect(res: http.ServerResponse, location: string, status = 302): void {
  res.statusCode = status;
  res.setHeader("Location", location);
  res.end();
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) {
      return v.trim();
    }
  }
  return null;
}

function toAbsoluteUrl(input: string, fallbackBase: string): string {
  try {
    return new URL(input, fallbackBase).toString();
  } catch {
    return input;
  }
}

export async function resolveMarketUrl(marketId: string): Promise<string | null> {
  const id = String(marketId || "").trim();
  if (!id) return null;

  const cached = marketUrlCache.get(id);
  if (cached && Date.now() - cached.ts < MARKET_URL_CACHE_TTL_MS) {
    return cached.url;
  }

  const cfg = loadConfig();
  const fallbackUrl = `${cfg.gammaHost}/markets/${encodeURIComponent(id)}`;
  let finalUrl = fallbackUrl;
  try {
    const { data } = await axios.get(fallbackUrl, { timeout: 8000 });
    const row = (data && typeof data === "object" && !Array.isArray(data))
      ? data
      : (data?.data && typeof data.data === "object" && !Array.isArray(data.data) ? data.data : null);

    if (row) {
      const directUrl = firstNonEmptyString(row.url, row.marketUrl, row.market_url);
      const slug = firstNonEmptyString(row.slug, row.marketSlug, row.market_slug);
      if (directUrl && /polymarket\.com/i.test(directUrl)) {
        finalUrl = toAbsoluteUrl(directUrl, "https://polymarket.com");
      } else if (slug) {
        finalUrl = `https://polymarket.com/event/${encodeURIComponent(slug)}`;
      }
    }
  } catch {
    // keep fallback
  }

  marketUrlCache.set(id, { ts: Date.now(), url: finalUrl });
  return finalUrl;
}

export function parsePositiveInt(raw: string | null | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function statusText(t: any): "WIN" | "LOSE" | "PENDING" | "CANCELED" {
  const status = String(t.orderStatus || "").trim().toUpperCase();
  const isCancelled = status && (status.includes("CANCEL") || status === "EXPIRED" || status === "REJECTED");
  if (isCancelled) return "CANCELED";
  if (!t.resolved) return "PENDING";
  return t.win ? "WIN" : "LOSE";
}

export function executionModeText(t: any): "LIVE" | "DRY_RUN" {
  if (t.executionMode === "LIVE" || t.executionMode === "DRY_RUN") return t.executionMode;
  return t.orderId && String(t.orderId).trim() ? "LIVE" : "DRY_RUN";
}
