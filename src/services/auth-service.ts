import crypto from "node:crypto";
import http from "node:http";

const AUTH_COOKIE_NAME = "pm_bot_web_session";
const AUTH_SESSION_TTL_MS = Math.max(
  30 * 60 * 1000, 
  Math.floor(Number(process.env.WEB_SESSION_TTL_MS || 12 * 60 * 60 * 1000))
);
const WEB_PASSWORD = String(process.env.WEB_PASSWORD || "").trim();
const AUTH_COOKIE_SECURE = ["1", "true", "yes", "on"].includes(String(process.env.WEB_SECURE_COOKIE || "").trim().toLowerCase());

const authSessions = new Map<string, number>();

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

export function isAuthEnabled(): boolean {
  return WEB_PASSWORD.length > 0;
}

export function isAuthenticated(req: http.IncomingMessage): boolean {
  if (!isAuthEnabled()) return true;
  pruneAuthSessions();
  const token = parseCookies(req)[AUTH_COOKIE_NAME];
  if (!token) return false;
  const expiresAtMs = authSessions.get(token);
  if (!expiresAtMs || expiresAtMs <= Date.now()) {
    authSessions.delete(token);
    return false;
  }
  // Slide window
  authSessions.set(token, Date.now() + AUTH_SESSION_TTL_MS);
  return true;
}

export function login(password: string): { ok: boolean; token?: string; error?: string } {
  if (!isAuthEnabled()) return { ok: true };
  if (password !== WEB_PASSWORD) return { ok: false, error: "invalid password" };
  
  const token = crypto.randomBytes(24).toString("hex");
  authSessions.set(token, Date.now() + AUTH_SESSION_TTL_MS);
  return { ok: true, token };
}

export function logout(req: http.IncomingMessage): void {
  const token = parseCookies(req)[AUTH_COOKIE_NAME];
  if (token) {
    authSessions.delete(token);
  }
}

export function setAuthCookie(res: http.ServerResponse, token: string): void {
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

export function clearAuthCookie(res: http.ServerResponse): void {
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
