import fs from "node:fs";
import path from "node:path";

const LOG_FILE = path.resolve("state", "runtime.log");
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

function isRetainedLogLine(line: string, cutoffMs: number): boolean {
  try {
    const parsed = JSON.parse(line);
    const ts = Date.parse(String(parsed?.ts ?? ""));
    return !Number.isFinite(ts) || ts >= cutoffMs;
  } catch {
    return true;
  }
}

export function tailLines(maxLines: number): string[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  const raw = fs.readFileSync(LOG_FILE, "utf8").trim();
  if (!raw) return [];

  const cutoffMs = Date.now() - LOG_RETENTION_MS;
  const lines = raw
    .split(/\r?\n/)
    .filter((x) => x.trim().length > 0)
    .filter((line) => isRetainedLogLine(line, cutoffMs));
    
  return lines.slice(-Math.max(1, maxLines));
}

export function getDisplayMsgs(maxLines = 100): string[] {
  const lines = tailLines(maxLines);
  return lines.map(line => {
    try {
      const raw = JSON.parse(line);
      const msg = raw.msg || line;
      const extra = raw.data && Object.keys(raw.data).length > 0 ? " " + JSON.stringify(raw.data) : "";
      return msg + extra;
    } catch {
      return line;
    }
  });
}

export function clearLogs(): void {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, "", "utf8");
}

export function appendWebLog(msg: string, obj?: unknown, tag = "web", level = "info"): void {
  const date = new Date();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const tsDisplay = `${m}-${d} ${h}:${min}`;
  
  const tsISO = date.toISOString();
  const tagPart = `[${tag}]`.padEnd(16);
  const levelPart = `[${level}]`.padEnd(10);
  const taggedMsg = `${tagPart} ${levelPart} ${msg}`;
  const line = JSON.stringify({ ts: tsISO, msg: `${tsDisplay} ${taggedMsg}`, data: obj }) + "\n";
  
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line, "utf8");
  } catch { }
}
