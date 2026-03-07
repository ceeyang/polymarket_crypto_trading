import { clamp } from "../utils.js";
import type { Prediction } from "../types.js";

function sigmoid(x: number): number {
  if (x > 30) return 1;
  if (x < -30) return 0;
  return 1 / (1 + Math.exp(-x));
}

export function predictEthUp5m(closes: number[]): Prediction {
  if (closes.length < 60) {
    return { probUp: 0.5, confidence: 0, modelScore: 0 };
  }

  const rets: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (prev <= 0 || !Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    rets.push((cur - prev) / prev);
  }

  if (rets.length < 40) {
    return { probUp: 0.5, confidence: 0, modelScore: 0 };
  }

  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
  const meanAbs = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + Math.abs(b), 0) / arr.length : 0);

  const m3 = sum(rets.slice(-3));
  const m5 = sum(rets.slice(-5));
  const m15 = sum(rets.slice(-15));
  const vol20 = meanAbs(rets.slice(-20)) + 1e-8;

  const score = 7.0 * (m3 / vol20) + 4.0 * (m5 / vol20) + 2.5 * (m15 / vol20);
  const probUp = clamp(sigmoid(score), 0.01, 0.99);
  const confidence = clamp(Math.abs(probUp - 0.5) * 2, 0, 1);

  return { probUp, confidence, modelScore: score };
}
