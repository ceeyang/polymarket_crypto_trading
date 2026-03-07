export const FEATURE_NAMES = [
  "ret_1",
  "ret_3",
  "ret_5",
  "ret_10",
  "ret_20",
  "vol_5",
  "vol_20",
  "mom5_over_vol20",
  "trend_sma20",
  "trend_sma50",
  "rsi14",
  "accel_3_10",
] as const;

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function mean(arr: number[]): number {
  if (!arr.length) return 0;
  return sum(arr) / arr.length;
}

function safeDiv(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(b) < 1e-12) return 0;
  return a / b;
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 0;

  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }

  const avgGain = gain / period;
  const avgLoss = loss / period;
  if (avgLoss <= 1e-12) return 1;
  const rs = avgGain / avgLoss;
  const rsiValue = 100 - 100 / (1 + rs);
  return (rsiValue - 50) / 50;
}

export function buildFeatureVector(closes: number[]): number[] | null {
  if (closes.length < 60) return null;

  const valid = closes.every((x) => Number.isFinite(x) && x > 0);
  if (!valid) return null;

  const rets: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  if (rets.length < 30) return null;

  const take = (n: number) => rets.slice(-n);
  const ret1 = sum(take(1));
  const ret3 = sum(take(3));
  const ret5 = sum(take(5));
  const ret10 = sum(take(10));
  const ret20 = sum(take(20));

  const vol5 = mean(take(5).map((x) => Math.abs(x)));
  const vol20 = mean(take(20).map((x) => Math.abs(x))) + 1e-8;

  const last = closes[closes.length - 1];
  const sma20 = mean(closes.slice(-20));
  const sma50 = mean(closes.slice(-50));

  const features = [
    ret1,
    ret3,
    ret5,
    ret10,
    ret20,
    vol5,
    vol20,
    safeDiv(ret5, vol20),
    safeDiv(last - sma20, sma20),
    safeDiv(last - sma50, sma50),
    rsi(closes, 14),
    ret3 - ret10 * 0.3,
  ];

  if (features.some((x) => !Number.isFinite(x))) return null;
  return features;
}
