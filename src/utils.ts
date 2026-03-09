export function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((x) => String(x));
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return [];
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x));
    } catch {
      // fallback: parse forms like ['a','b'] or a,b
      const normalized = t
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((x) => x.trim().replace(/^['\"]|['\"]$/g, ""))
        .filter((x) => x.length > 0);
      return normalized;
    }
  }
  return [];
}

export function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
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

export function hasClockHint(text: string): boolean {
  return /\b\d{1,2}:\d{2}\b/.test(text);
}
