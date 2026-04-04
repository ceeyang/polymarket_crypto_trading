import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { URL, fileURLToPath } from "node:url";

import { 
  MAX_ORDER_ENTRIES, 
  MAX_TARGETS, 
  loadConfig, 
  readRuntimeConfig, 
  writeRuntimeConfig, 
  type RuntimeConfigFile 
} from "./config.js";
import { 
  readBotControlState, 
  resolveBotControlMode, 
  writeBotControlState 
} from "./services/bot-control.js";
import { claimRedeemablePositions } from "./services/claim-service.js";
import { StateStore } from "./services/state-store.js";

import {
  isAuthEnabled,
  isAuthenticated,
  login,
  logout,
  setAuthCookie,
  clearAuthCookie
} from "./services/auth-service.js";
import {
  fetchAccountSummaryCached,
  invalidateAccountCache
} from "./services/account-service.js";
import {
  getDisplayMsgs,
  clearLogs,
  appendWebLog
} from "./services/log-service.js";
import {
  sendJson,
  sendText,
  redirect,
  readBody,
  resolveMarketUrl,
  parsePositiveInt,
  toNumber,
  statusText,
  executionModeText
} from "./services/web-utils.js";
import { getAppVersion } from "./services/app-status-service.js";

const PORT = Number(process.env.WEB_PORT || 8787);
const UI_FILE = path.resolve("src", "web-ui", "index.html");
const LOGIN_UI_FILE = path.resolve("src", "web-ui", "login.html");
const RELOAD_SIGNAL_FILE = path.resolve("state", "config.reload.signal");

const stateStore = new StateStore();

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
  const orderEntries = data.strategy.dualSide?.orderEntries;
  if (Array.isArray(orderEntries) && orderEntries.length > MAX_ORDER_ENTRIES) {
    return { ok: false, error: `strategy.dualSide.orderEntries exceeds ${MAX_ORDER_ENTRIES}` };
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
  let _analysisCache: any = null;
  let _analysisCacheTime = 0;

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const parsedUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      const pathnameRaw = parsedUrl.pathname;
      const pathname = pathnameRaw.length > 1 && pathnameRaw.endsWith("/")
        ? pathnameRaw.slice(0, -1)
        : pathnameRaw;

      if (method === "GET" && pathname === "/login") {
        if (!isAuthEnabled() || isAuthenticated(req)) {
          redirect(res, "/");
          return;
        }
        sendText(res, 200, "text/html; charset=utf-8", readHtmlFile(LOGIN_UI_FILE, "Login"));
        return;
      }

      if (method === "GET" && pathname === "/api/auth/session") {
        sendJson(res, 200, {
          enabled: isAuthEnabled(),
          authenticated: isAuthenticated(req),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/auth/login") {
        const body = await readBody(req);
        let payload: any;
        try {
          payload = JSON.parse(body || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        
        const result = login(String(payload?.password || ""));
        if (!result.ok) {
          sendJson(res, 401, { error: result.error });
          return;
        }

        if (result.token) {
          setAuthCookie(res, result.token);
        }
        sendJson(res, 200, { ok: true, enabled: isAuthEnabled() });
        return;
      }

      if (method === "POST" && pathname === "/api/auth/logout") {
        logout(req);
        clearAuthCookie(res);
        sendJson(res, 200, { ok: true, enabled: isAuthEnabled() });
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
        sendJson(res, 200, getAppVersion());
        return;
      }

      if (method === "GET" && pathname === "/api/bot/control") {
        const view = getBotControlView() as any;
        try {
          const content = fs.readFileSync(path.resolve("state", "last_claim.txt"), "utf8");
          view.lastClaimAtMs = parseInt(content.trim(), 10) || 0;
        } catch {
          view.lastClaimAtMs = 0;
        }
        sendJson(res, 200, view);
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
        const tail = parsePositiveInt(parsedUrl.searchParams.get("tail"), 100);
        sendJson(res, 200, { lines: getDisplayMsgs(tail) });
        return;
      }

      if ((method === "POST" || method === "DELETE") && pathname === "/api/logs/clear") {
        clearLogs();
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
          logger: appendWebLog,
        });
        invalidateAccountCache();
        const account = await fetchAccountSummaryCached(0);
        sendJson(res, 200, { ok: true, claim, account });
        return;
      }

      if (method === "GET" && pathname === "/api/trades/grouped") {
        const items = stateStore.getMarketGroupedSummary();
        sendJson(res, 200, { items });
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
          summary: stateStore.getPerformanceSummary("ALL"),
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

      if (method === "GET" && pathname === "/api/trades/analysis") {
        const nowMs = Date.now();
        if (_analysisCache && (nowMs - _analysisCacheTime < 3000)) {
          sendJson(res, 200, _analysisCache);
          return;
        }

        const state = stateStore.load();
        const trades = state.trades || [];
        
        const targetsMap = new Map<string, any>();

        for (const t of trades) {
          const matched = toNumber(t.matchedSize);
          const price = toNumber(t.entryPrice);
          const target = String(t.targetId || "UNKNOWN_TARGET");
          let tg = targetsMap.get(target);
          if (!tg) {
             tg = { targetId: target, tiers: new Map<string, any>(), totalPlanned: 0, totalMatched: 0, totalCost: 0, totalPnl: 0 };
             targetsMap.set(target, tg);
          }
          tg.totalPlanned += toNumber(t.orderPlanShareSize);
          tg.totalMatched += matched;
          const priceKey = toNumber(t.orderPlanPrice).toFixed(3);
          let tier = tg.tiers.get(priceKey);
          if (!tier) {
             tier = { price: Number(priceKey), planned: 0, matched: 0, cost: 0, pnl: 0, winShares: 0, doubleFills: 0, markets: 0 };
             tg.tiers.set(priceKey, tier);
          }
          tier.planned += toNumber(t.orderPlanShareSize);
          tier.matched += matched;
          tier.cost += matched * price;
          if (t.resolved) {
            if (t.officialPnlUsd != null) tier.pnl += t.officialPnlUsd;
            else tier.pnl += t.win ? (matched * (1.0 - price)) : -(matched * price);
            if (t.win) tier.winShares += matched;
          }
        }

        const targets = Array.from(targetsMap.values()).map(tg => ({
          ...tg,
          tiers: Array.from(tg.tiers.values()).sort((a: any, b: any) => b.price - a.price)
        }));

        _analysisCache = { targets };
        _analysisCacheTime = nowMs;
        sendJson(res, 200, _analysisCache);
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      console.error("web error", err);
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    if (!options?.silent) {
       console.log(`Web interface running at http://0.0.0.0:${port}`);
    }
  });

  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer();
}
