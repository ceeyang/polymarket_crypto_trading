import "dotenv/config";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execSync } from "node:child_process";
import { URL, fileURLToPath } from "node:url";
import axios from "axios";
import { Wallet } from "ethers";

import { MAX_ORDER_ENTRIES, MAX_TARGETS, loadConfig, readRuntimeConfig, writeRuntimeConfig, type RuntimeConfigFile } from "./config.js";
import { PolymarketTrader } from "./clients/polymarket.js";
import { readBotControlState, resolveBotControlMode, writeBotControlState } from "./services/bot-control.js";
import { claimRedeemablePositions } from "./services/claim-service.js";
import { StateStore } from "./services/state-store.js";
import type { LiveTradeRecord } from "./types.js";

const PORT = Number(process.env.WEB_PORT || 8787);
const UI_FILE = path.resolve("src", "web-ui", "index.html");
const LOGIN_UI_FILE = path.resolve("src", "web-ui", "login.html");
const LOG_FILE = path.resolve("state", "runtime.log");
const RELOAD_SIGNAL_FILE = path.resolve("state", "config.reload.signal");
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
const WEB_PASSWORD = String(process.env.WEB_PASSWORD || "").trim();
const WEB_AUTH_ENABLED = WEB_PASSWORD.length > 0;
const AUTH_COOKIE_NAME = "pm_bot_web_session";
const AUTH_SESSION_TTL_MS = Math.max(30 * 60 * 1000, Math.floor(Number(process.env.WEB_SESSION_TTL_MS || 12 * 60 * 60 * 1000)));
const AUTH_COOKIE_SECURE = ["1", "true", "yes", "on"].includes(String(process.env.WEB_SECURE_COOKIE || "").trim().toLowerCase());
const stateStore = new StateStore();
let accountCache: { ts: number; data: Awaited<ReturnType<typeof fetchAccountSummary>> } | null = null;
const marketUrlCache = new Map<string, { ts: number; url: string }>();
const MARKET_URL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const authSessions = new Map<string, number>();

// ── 版本信息（进程启动时一次性读取）───────────────────────────────────
function readAppVersion(): { version: string; commit: string; startedAt: string } {
  let version = "unknown";
  try {
    const pkgPath = path.resolve("package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    // ignore
  }

  let commit = "unknown";
  try {
    commit = execSync("git rev-parse --short HEAD", { encoding: "utf8", timeout: 3000 }).trim();
  } catch {
    // ignore — no git or not a repo
  }

  return { version, commit, startedAt: new Date().toISOString() };
}

const APP_VERSION = readAppVersion();
// ─────────────────────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function sendText(res: http.ServerResponse, status: number, contentType: string, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.end(body);
}

function redirect(res: http.ServerResponse, location: string, status = 302): void {
  res.statusCode = status;
  res.setHeader("Location", location);
  res.end();
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const header = String(req.headers.cookie || "");
  const pairs = header.split(";").map((part) => part.trim()).filter(Boolean);
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function pruneAuthSessions(nowMs = Date.now()): void {
  for (const [token, expiresAtMs] of authSessions.entries()) {
    if (expiresAtMs <= nowMs) {
      authSessions.delete(token);
    }
  }
}

function setAuthCookie(res: http.ServerResponse, token: string): void {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(AUTH_SESSION_TTL_MS / 1000)}`,
  ];
  if (AUTH_COOKIE_SECURE) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAuthCookie(res: http.ServerResponse): void {
  const parts = [
    `${AUTH_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (AUTH_COOKIE_SECURE) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function isAuthenticated(req: http.IncomingMessage): boolean {
  if (!WEB_AUTH_ENABLED) return true;
  pruneAuthSessions();
  const token = parseCookies(req)[AUTH_COOKIE_NAME];
  if (!token) return false;
  const expiresAtMs = authSessions.get(token);
  if (!expiresAtMs || expiresAtMs <= Date.now()) {
    authSessions.delete(token);
    return false;
  }
  authSessions.set(token, Date.now() + AUTH_SESSION_TTL_MS);
  return true;
}

function requireWebAuth(req: http.IncomingMessage, res: http.ServerResponse, isApiRequest: boolean): boolean {
  if (isAuthenticated(req)) return true;
  if (isApiRequest) {
    sendJson(res, 401, { error: "unauthorized" });
  } else {
    redirect(res, "/login");
  }
  return false;
}

function readHtmlFile(filePath: string, fallbackTitle: string): string {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf8");
  }
  return `<!doctype html><html><head><meta charset="utf-8" /><title>${fallbackTitle}</title></head><body><h1>${fallbackTitle}</h1></body></html>`;
}

function isRetainedLogLine(line: string, cutoffMs: number): boolean {
  try {
    const parsed = JSON.parse(line);
    const ts = Date.parse(String(parsed?.ts ?? ""));
    return !Number.isFinite(ts) || ts >= cutoffMs;
  } catch {
    return true;
  }
}

function tailLines(filePath: string, maxLines: number): string[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const cutoffMs = Date.now() - LOG_RETENTION_MS;
  const lines = raw
    .split(/\r?\n/)
    .filter((x) => x.trim().length > 0)
    .filter((line) => isRetainedLogLine(line, cutoffMs));
  return lines.slice(-Math.max(1, maxLines));
}

function clearLogFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "", "utf8");
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function isCancelledTrade(t: LiveTradeRecord): boolean {
  const status = String(t.orderStatus || "").trim().toUpperCase();
  if (!status) return false;
  return status.includes("CANCEL") || status === "EXPIRED" || status === "REJECTED";
}

function summarizeTrades(trades: LiveTradeRecord[]): {
  totalTrades: number;
  settledTrades: number;
  pendingTrades: number;
  wins: number;
  losses: number;
  winRate: number;
} {
  const settled = trades.filter((x) => x.resolved && !isCancelledTrade(x));
  const wins = settled.filter((x) => x.win).length;
  const losses = settled.length - wins;
  const pending = trades.filter((x) => !x.resolved && !isCancelledTrade(x)).length;
  return {
    totalTrades: trades.length,
    settledTrades: settled.length,
    pendingTrades: pending,
    wins,
    losses,
    winRate: settled.length > 0 ? wins / settled.length : 0,
  };
}

function statusText(t: LiveTradeRecord): "WIN" | "LOSE" | "PENDING" | "CANCELED" {
  if (isCancelledTrade(t)) return "CANCELED";
  if (!t.resolved) return "PENDING";
  return t.win ? "WIN" : "LOSE";
}

function executionModeText(t: LiveTradeRecord): "LIVE" | "DRY_RUN" {
  if (t.executionMode === "LIVE" || t.executionMode === "DRY_RUN") return t.executionMode;
  return t.orderId && String(t.orderId).trim() ? "LIVE" : "DRY_RUN";
}

function pickAddress(privateKey: string, funder?: string): string | null {
  if (funder && funder.trim()) return funder.trim();
  if (!privateKey) return null;
  try {
    return new Wallet(privateKey).address;
  } catch {
    return null;
  }
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function rawUsdcToNumber(raw: string): number {
  try {
    return Number(raw) / 1_000_000;
  } catch {
    return 0;
  }
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

async function resolveMarketUrl(marketId: string): Promise<string | null> {
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

async function fetchAccountSummary(): Promise<{
  user: string | null;
  collateralUsdc: number;
  collateralRaw: string;
  portfolioValueUsd: number;
  totalEquityUsd: number;
  collateralError?: string;
}> {
  const cfg = loadConfig();
  const user = pickAddress(cfg.privateKey, cfg.funderAddress);
  if (!user) {
    return {
      user: null,
      collateralUsdc: 0,
      collateralRaw: "0",
      portfolioValueUsd: 0,
      totalEquityUsd: 0,
      collateralError: "missing FUNDER_ADDRESS/PRIVATE_KEY",
    };
  }

  const valueResp = await axios.get(`${cfg.dataApiHost}/value`, {
    params: { user },
    timeout: 15000,
  }).catch(() => ({ data: [] }));
  const portfolioRows = Array.isArray(valueResp.data) ? valueResp.data : [];
  const portfolioValueUsd = portfolioRows.reduce((acc: number, row: any) => acc + toNumber(row?.value), 0);

  let collateralRaw = "0";
  let collateralUsdc = 0;
  let collateralError: string | undefined;
  if (!cfg.privateKey) {
    collateralError = "PRIVATE_KEY missing";
  } else {
    try {
      const trader = await PolymarketTrader.create(cfg, { forceClient: true });
      const collateral = await trader.getBalanceAllowance({ assetType: "COLLATERAL" });
      collateralRaw = String(collateral?.balance ?? "0");
      collateralUsdc = rawUsdcToNumber(collateralRaw);
    } catch (err) {
      collateralError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    user,
    collateralUsdc,
    collateralRaw,
    portfolioValueUsd,
    totalEquityUsd: collateralUsdc + portfolioValueUsd,
    collateralError,
  };
}

async function fetchAccountSummaryCached(maxAgeMs = 8000): Promise<Awaited<ReturnType<typeof fetchAccountSummary>>> {
  const now = Date.now();
  if (accountCache && now - accountCache.ts <= maxAgeMs) {
    return accountCache.data;
  }
  const data = await fetchAccountSummary();
  accountCache = { ts: now, data };
  return data;
}

function validateRuntimeConfig(payload: unknown): { ok: true; data: RuntimeConfigFile } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "config must be object" };
  }
  const data = payload as RuntimeConfigFile;
  if (!data.runtime || !data.strategy || !data.network) {
    return { ok: false, error: "missing required top-level sections" };
  }
  const targets = data.strategy.targets;
  if (Array.isArray(targets) && targets.length > MAX_TARGETS) {
    return { ok: false, error: `strategy.targets exceeds ${MAX_TARGETS}` };
  }
  const orderEntries = data.strategy.orderEntries;
  if (Array.isArray(orderEntries) && orderEntries.length > MAX_ORDER_ENTRIES) {
    return { ok: false, error: `strategy.orderEntries exceeds ${MAX_ORDER_ENTRIES}` };
  }
  return { ok: true, data };
}

function touchReloadSignal(): number {
  fs.mkdirSync(path.dirname(RELOAD_SIGNAL_FILE), { recursive: true });
  const ts = Date.now();
  fs.writeFileSync(RELOAD_SIGNAL_FILE, String(ts), "utf8");
  return ts;
}

function getBotControlView(): {
  mode: "WEB_CONTROLLED" | "STANDALONE";
  switchEnabled: boolean;
  scanningEnabled: boolean;
  effectiveScanning: boolean;
  updatedAt: string;
  updatedBy: string;
} {
  const mode = resolveBotControlMode(process.env.BOT_CONTROL_MODE);
  const switchEnabled = mode === "WEB_CONTROLLED";
  const state = readBotControlState();
  const scanningEnabled = switchEnabled ? Boolean(state.scanningEnabled) : true;
  return {
    mode,
    switchEnabled,
    scanningEnabled,
    effectiveScanning: scanningEnabled,
    updatedAt: state.updatedAt,
    updatedBy: state.updatedBy,
  };
}

export function startServer(port = PORT, options?: { silent?: boolean }): http.Server {
  function formatDate(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${m}-${d} ${h}:${min}`;
}

function webLog(msg: string, obj?: unknown, tag = "web-claim", level = "info") {
  const tsISO = new Date().toISOString();
  const tsDisplay = formatDate(new Date());
  const taggedMsg = `[${tag}] [${level}] ${msg}`;
  const line = JSON.stringify({ ts: tsISO, msg: `${tsDisplay} ${taggedMsg}`, data: obj }) + "\n";
  try {
    fs.appendFileSync(LOG_FILE, line, "utf8");
  } catch {}
}

const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const parsedUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      const pathnameRaw = parsedUrl.pathname;
      const pathname = pathnameRaw.length > 1 && pathnameRaw.endsWith("/")
        ? pathnameRaw.slice(0, -1)
        : pathnameRaw;

      if (method === "GET" && pathname === "/login") {
        if (!WEB_AUTH_ENABLED || isAuthenticated(req)) {
          redirect(res, "/");
          return;
        }
        sendText(res, 200, "text/html; charset=utf-8", readHtmlFile(LOGIN_UI_FILE, "Login"));
        return;
      }

      if (method === "GET" && pathname === "/api/auth/session") {
        sendJson(res, 200, {
          enabled: WEB_AUTH_ENABLED,
          authenticated: isAuthenticated(req),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/auth/login") {
        let payload: any;
        try {
          payload = JSON.parse(await readBody(req) || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!WEB_AUTH_ENABLED) {
          sendJson(res, 200, { ok: true, enabled: false });
          return;
        }
        if (String(payload?.password || "") !== WEB_PASSWORD) {
          sendJson(res, 401, { error: "invalid password" });
          return;
        }
        const token = crypto.randomBytes(24).toString("hex");
        authSessions.set(token, Date.now() + AUTH_SESSION_TTL_MS);
        setAuthCookie(res, token);
        sendJson(res, 200, { ok: true, enabled: true });
        return;
      }

      if (method === "POST" && pathname === "/api/auth/logout") {
        const token = parseCookies(req)[AUTH_COOKIE_NAME];
        if (token) {
          authSessions.delete(token);
        }
        clearAuthCookie(res);
        sendJson(res, 200, { ok: true, enabled: WEB_AUTH_ENABLED });
        return;
      }

      if (method === "GET" && pathname === "/") {
        if (!requireWebAuth(req, res, false)) return;
        const html = readHtmlFile(UI_FILE, "Dashboard");
        sendText(res, 200, "text/html; charset=utf-8", html);
        return;
      }

      if (pathname.startsWith("/api/") && !pathname.startsWith("/api/auth/")) {
        if (!requireWebAuth(req, res, true)) return;
      }

      if (method === "GET" && pathname === "/api/version") {
        sendJson(res, 200, APP_VERSION);
        return;
      }

      if (method === "GET" && pathname === "/api/bot/control") {
        sendJson(res, 200, getBotControlView());
        return;
      }

      if (method === "PUT" && pathname === "/api/bot/control") {
        const view = getBotControlView();
        if (!view.switchEnabled) {
          sendJson(res, 409, {
            error: "bot control switch is disabled in standalone mode",
            ...view,
          });
          return;
        }
        const body = await readBody(req);
        let payload: any;
        try {
          payload = JSON.parse(body || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (typeof payload?.scanningEnabled !== "boolean") {
          sendJson(res, 400, { error: "scanningEnabled(boolean) is required" });
          return;
        }
        writeBotControlState(payload.scanningEnabled, "web_ui");
        sendJson(res, 200, getBotControlView());
        return;
      }

      if (method === "GET" && pathname === "/api/config") {
        sendJson(res, 200, readRuntimeConfig());
        return;
      }

      if (method === "PUT" && pathname === "/api/config") {
        const body = await readBody(req);
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        const validated = validateRuntimeConfig(payload);
        if (!validated.ok) {
          sendJson(res, 400, { error: validated.error });
          return;
        }
        writeRuntimeConfig(validated.data);
        const reloadToken = touchReloadSignal();
        sendJson(res, 200, { ok: true, reloadToken });
        return;
      }

      if (method === "GET" && pathname === "/api/logs") {
        const tail = Number(parsedUrl.searchParams.get("tail") || "200");
        const rawLines = tailLines(LOG_FILE, Number.isFinite(tail) ? tail : 200);
        const lines = rawLines.map((line) => {
          try {
            const parsed = JSON.parse(line);
            return parsed.msg || line;
          } catch {
            return line;
          }
        });
        sendJson(res, 200, { lines });
        return;
      }

      if ((method === "POST" || method === "DELETE") && pathname === "/api/logs/clear") {
        clearLogFile(LOG_FILE);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && pathname === "/api/account") {
        const summary = await fetchAccountSummaryCached();
        sendJson(res, 200, summary);
        return;
      }

      if (method === "POST" && pathname === "/api/account/claim") {
        const cfg = loadConfig();
        const claim = await claimRedeemablePositions(cfg, {
          logPrefix: "[web-claim]",
          quietNoop: false,
          maxConcurrency: 3,
          forceLive: true,
          logger: webLog,
        });
        accountCache = null;
        const account = await fetchAccountSummaryCached(0);
        sendJson(res, 200, { ok: true, claim, account });
        return;
      }

      if (method === "GET" && pathname === "/api/trades") {
        const page = parsePositiveInt(parsedUrl.searchParams.get("page"), 1);
        const pageSize = Math.min(100, parsePositiveInt(parsedUrl.searchParams.get("pageSize"), 20));
        const targetId = String(parsedUrl.searchParams.get("targetId") || "").trim();
        const resolvedParam = String(parsedUrl.searchParams.get("resolved") || "").trim().toLowerCase();

        const state = stateStore.load();
        const allTrades = [...(state.trades ?? [])];
        allTrades.sort((a, b) => Date.parse(b.entryTime) - Date.parse(a.entryTime));

        const filtered = allTrades.filter((t) => {
          if (targetId && t.targetId !== targetId) return false;
          if (resolvedParam === "true" && !t.resolved) return false;
          if (resolvedParam === "false" && t.resolved) return false;
          return true;
        });

        const total = filtered.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const safePage = Math.min(Math.max(1, page), totalPages);
        const start = (safePage - 1) * pageSize;
        const pageTrades = filtered.slice(start, start + pageSize);
        const items = await Promise.all(pageTrades.map(async (t) => ({
          ...t,
          status: statusText(t),
          executionMode: executionModeText(t),
          marketUrl: await resolveMarketUrl(String(t.marketId || "")),
        })));

        sendJson(res, 200, {
          summary: summarizeTrades(filtered),
          pagination: {
            page: safePage,
            pageSize,
            total,
            totalPages,
            hasPrev: safePage > 1,
            hasNext: safePage < totalPages,
          },
          items,
        });
        return;
      }

      if ((method === "POST" || method === "DELETE") && pathname === "/api/trades/clear") {
        stateStore.clearTrades(true);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && pathname === "/api/predictions") {
        const limit = Math.min(200, parsePositiveInt(parsedUrl.searchParams.get("limit"), 50));
        const items = stateStore.listPredictions(limit);
        sendJson(res, 200, { items });
        return;
      }

      if ((method === "POST" || method === "DELETE") && pathname === "/api/predictions/clear") {
        stateStore.clearPredictions();
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    if (!options?.silent) {
      console.log(`[web] dashboard running on http://127.0.0.1:${port}`);
    }
  });
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  startServer();
}
