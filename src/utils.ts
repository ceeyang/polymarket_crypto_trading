export function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  if (typeof raw !== "string") return [];
  const text = raw.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x));
  } catch {
    // fallback: parse forms like ['a','b'] or a,b
    const normalized = text
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((x) => x.trim().replace(/^['\"]|['\"]$/g, ""))
      .filter((x) => x.length > 0);
    return normalized;
  }
  return [];
}

export function parseNumberArray(raw: unknown): number[] {
  return parseStringArray(raw)
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));
}

export function parseFinite(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

export function normalizeConditionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(v)) return null;
  return v;
}

export function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function toFiniteNumber(raw: unknown, fallback = NaN): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function minutesUntil(iso: string, now = new Date()): number {
  const t = new Date(iso).getTime();
  return (t - now.getTime()) / 60000;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function hasEthKeyword(text: string): boolean {
  const s = text.toLowerCase();
  return /\beth\b|\bethereum\b/.test(s);
}

export function has5mHint(text: string): boolean {
  const s = text.toLowerCase();
  return (
    /\b5m\b/.test(s)
    || /\b5\s*min(?:ute)?s?\b/.test(s)
    || /5分钟/.test(s)
  );
}

export function has15mHint(text: string): boolean {
  const s = text.toLowerCase();
  return (
    /\b15m\b/.test(s)
    || /\b15\s*min(?:ute)?s?\b/.test(s)
    || /15分钟/.test(s)
  );
}

export function has1hHint(text: string): boolean {
  const s = text.toLowerCase();
  return (
    /\b1h\b/.test(s)
    || /\b60m\b/.test(s)
    || /\b60\s*min(?:ute)?s?\b/.test(s)
    || /\b1\s*hour\b/.test(s)
    || /1小时/.test(s)
    || /60分钟/.test(s)
  );
}


export function hasClockHint(text: string): boolean {
  return /\b\d{1,2}:\d{2}\b/.test(text);
}

export function isCancelledOrderStatus(raw: unknown): boolean {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return false;
  // FILLED 和 MATCHED 也是终端状态，不需要也无法撤单
  return s.includes("CANCEL") || s === "EXPIRED" || s === "REJECTED" || s === "FILLED" || s === "MATCHED";
}
