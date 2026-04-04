import fs from "node:fs";
import path from "node:path";

const LOG_FILE = path.resolve("state", "runtime.log");
const LOG_TO_STDOUT = !["0", "false", "off", "no"].includes(String(process.env.LOG_TO_STDOUT || "1").trim().toLowerCase());
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
const LOG_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
let lastLogPruneAtMs = 0;

function isLogLineRetained(line: string, cutoffMs: number): boolean {
  try {
    const parsed = JSON.parse(line);
    const ts = Date.parse(String(parsed?.ts ?? ""));
    return !Number.isFinite(ts) || ts >= cutoffMs;
  } catch {
    return true;
  }
}

function pruneRuntimeLogFile(nowMs = Date.now()): void {
  if (nowMs - lastLogPruneAtMs < LOG_PRUNE_INTERVAL_MS) return;
  lastLogPruneAtMs = nowMs;

  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const cutoffMs = nowMs - LOG_RETENTION_MS;
    const raw = fs.readFileSync(LOG_FILE, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const kept = lines.filter((line) => isLogLineRetained(line, cutoffMs));
    if (kept.length === lines.length) return;
    fs.writeFileSync(LOG_FILE, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
  } catch {
    // best effort
  }
}

function appendRuntimeLog(ts: string, msg: string, obj?: unknown): void {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    // prune is still sync but we run it less often by probability or a separate timer
    if (Math.random() < 0.01) pruneRuntimeLogFile(); 
    
    const payload = obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
    const logLine = JSON.stringify({ ts, msg, data: payload }) + "\n";
    
    // Use async append to not block the event loop
    fs.appendFile(LOG_FILE, logLine, "utf8", () => {});
  } catch {
    // best effort
  }
}

function formatDate(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const sec = String(date.getSeconds()).padStart(2, "0");
  return `${m}-${d} ${h}:${min}:${sec}`;
}

export function log(msg: string, obj?: unknown, tag = "system", level = "info") {
  const tsISO = new Date().toISOString();
  const tsDisplay = formatDate(new Date());
  const tagPart = `[${tag}]`.padEnd(16);
  const levelPart = `[${level}]`.padEnd(10);
  const taggedMsg = `${tagPart} ${levelPart} ${msg}`;

  if (LOG_TO_STDOUT) {
    if (obj == null) {
      console.log(`${tsDisplay} ${taggedMsg}`);
    } else {
      console.log(`${tsDisplay} ${taggedMsg}`, obj);
    }
  }
  appendRuntimeLog(tsISO, `${tsDisplay} ${taggedMsg}`, obj);
}

export function logInfo(msg: string, obj?: unknown, tag = "system") { log(msg, obj, tag, "info"); }
export function logWarn(msg: string, obj?: unknown, tag = "system") { log(msg, obj, tag, "warn"); }
export function logError(msg: string, obj?: unknown, tag = "system") { log(msg, obj, tag, "error"); }
export function logSuccess(msg: string, obj?: unknown, tag = "system") { log(msg, obj, tag, "success"); }
