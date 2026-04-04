import fs from "node:fs";
import path from "node:path";

import { BotControlMode } from "../types.js";

export interface BotControlState {
  scanningEnabled: boolean;
  updatedAt: string;
  updatedBy: string;
}

const BOT_CONTROL_FILE = path.resolve("state", "bot-control.json");

function defaultState(): BotControlState {
  return {
    scanningEnabled: true,
    updatedAt: new Date().toISOString(),
    updatedBy: "default",
  };
}

export function readBotControlState(): BotControlState {
  try {
    if (!fs.existsSync(BOT_CONTROL_FILE)) {
      return defaultState();
    }
    const raw = fs.readFileSync(BOT_CONTROL_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<BotControlState>;
    return {
      scanningEnabled: Boolean(parsed.scanningEnabled),
      updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim()
        ? parsed.updatedAt
        : new Date().toISOString(),
      updatedBy: typeof parsed.updatedBy === "string" && parsed.updatedBy.trim()
        ? parsed.updatedBy
        : "unknown",
    };
  } catch {
    return defaultState();
  }
}

export function writeBotControlState(scanningEnabled: boolean, updatedBy: string): BotControlState {
  const next: BotControlState = {
    scanningEnabled: Boolean(scanningEnabled),
    updatedAt: new Date().toISOString(),
    updatedBy: String(updatedBy || "unknown"),
  };
  fs.mkdirSync(path.dirname(BOT_CONTROL_FILE), { recursive: true });
  fs.writeFileSync(BOT_CONTROL_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function resolveBotControlMode(raw: string | undefined): BotControlMode {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "web" || s === "web_controlled" || s === "controlled") {
    return "WEB_CONTROLLED";
  }
  return "STANDALONE";
}

const CONFIG_KEY_FILE = path.resolve("state", "config.key");
const RELOAD_TOKEN_FILE = path.resolve("state", "config.reload.token");

export function readConfigKey(): string {
  try {
    if (!fs.existsSync(CONFIG_KEY_FILE)) return "default";
    return fs.readFileSync(CONFIG_KEY_FILE, "utf8").trim() || "default";
  } catch {
    return "default";
  }
}

export function readReloadToken(): number {
  try {
    if (!fs.existsSync(RELOAD_TOKEN_FILE)) return 0;
    const raw = fs.readFileSync(RELOAD_TOKEN_FILE, "utf8").trim();
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
