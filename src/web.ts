import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { URL, fileURLToPath } from "node:url";
import axios from "axios";
import { Wallet } from "ethers";

import { MAX_TARGETS, loadConfig, readRuntimeConfig, writeRuntimeConfig, type RuntimeConfigFile } from "./config.js";
import { PolymarketTrader } from "./clients/polymarket.js";
import { StateStore } from "./services/state-store.js";
import type { LiveTradeRecord } from "./types.js";

const PORT = Number(process.env.WEB_PORT || 8787);
const UI_FILE = path.resolve("src", "web-ui", "index.html");
const LOG_FILE = path.resolve("state", "runtime.log");
const RELOAD_SIGNAL_FILE = path.resolve("state", "config.reload.signal");
const stateStore = new StateStore();
let accountCache: { ts: number; data: Awaited<ReturnType<typeof fetchAccountSummary>> } | null = null;

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

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function tailLines(filePath: string, maxLines: number): string[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((x) => x.trim().length > 0);
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

function summarizeTrades(trades: LiveTradeRecord[]): {
  totalTrades: number;
  settledTrades: number;
  pendingTrades: number;
  wins: number;
  losses: number;
  winRate: number;
} {
  const settled = trades.filter((x) => x.resolved);
  const wins = settled.filter((x) => x.win).length;
  const losses = settled.length - wins;
  return {
    totalTrades: trades.length,
    settledTrades: settled.length,
    pendingTrades: trades.length - settled.length,
    wins,
    losses,
    winRate: settled.length > 0 ? wins / settled.length : 0,
  };
}

function statusText(t: LiveTradeRecord): "WIN" | "LOSE" | "PENDING" {
  if (!t.resolved) return "PENDING";
  return t.win ? "WIN" : "LOSE";
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
  if (!data.runtime || !data.prediction || !data.marketFilter || !data.network || !data.training) {
    return { ok: false, error: "missing required top-level sections" };
  }
  const targets = data.prediction.targets;
  if (Array.isArray(targets) && targets.length > MAX_TARGETS) {
    return { ok: false, error: `prediction.targets exceeds ${MAX_TARGETS}` };
  }
  return { ok: true, data };
}

function touchReloadSignal(): number {
  fs.mkdirSync(path.dirname(RELOAD_SIGNAL_FILE), { recursive: true });
  const ts = Date.now();
  fs.writeFileSync(RELOAD_SIGNAL_FILE, String(ts), "utf8");
  return ts;
}

export function startServer(port = PORT): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const parsedUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      const pathnameRaw = parsedUrl.pathname;
      const pathname = pathnameRaw.length > 1 && pathnameRaw.endsWith("/")
        ? pathnameRaw.slice(0, -1)
        : pathnameRaw;

      if (method === "GET" && pathname === "/") {
        const html = fs.existsSync(UI_FILE)
          ? fs.readFileSync(UI_FILE, "utf8")
          : "<h1>UI file not found</h1>";
        sendText(res, 200, "text/html; charset=utf-8", html);
        return;
      }

      if (method === "GET" && pathname === "/api/config") {
        const cfg = readRuntimeConfig();
        sendJson(res, 200, cfg);
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
        const lines = tailLines(LOG_FILE, Number.isFinite(tail) ? tail : 200);
        sendJson(res, 200, { lines });
        return;
      }

      if (method === "GET" && pathname === "/api/account") {
        const summary = await fetchAccountSummaryCached();
        sendJson(res, 200, summary);
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
        const items = filtered.slice(start, start + pageSize).map((t) => ({
          ...t,
          status: statusText(t),
        }));

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

      if ((method === "POST" || method === "DELETE") && pathname === "/api/logs/clear") {
        clearLogFile(LOG_FILE);
        sendJson(res, 200, { ok: true });
        return;
      }

      if ((method === "POST" || method === "DELETE") && pathname === "/api/trades/clear") {
        stateStore.clearTrades(true);
        sendJson(res, 200, { ok: true });
        return;
      }

      if ((method === "POST" || method === "DELETE") && pathname === "/api/logs" && parsedUrl.searchParams.get("action") === "clear") {
        clearLogFile(LOG_FILE);
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[web] dashboard running on http://127.0.0.1:${port}`);
  });
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  startServer();
}
