import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { URL } from "node:url";

import { MAX_TARGETS, readRuntimeConfig, writeRuntimeConfig, type RuntimeConfigFile } from "./config.js";

const PORT = Number(process.env.WEB_PORT || 8787);
const UI_FILE = path.resolve("src", "web-ui", "index.html");
const LOG_FILE = path.resolve("state", "runtime.log");

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

function startServer(): void {
  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const parsedUrl = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
      const pathname = parsedUrl.pathname;

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
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && pathname === "/api/logs") {
        const tail = Number(parsedUrl.searchParams.get("tail") || "200");
        const lines = tailLines(LOG_FILE, Number.isFinite(tail) ? tail : 200);
        sendJson(res, 200, { lines });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[web] dashboard running on http://127.0.0.1:${PORT}`);
  });
}

startServer();
