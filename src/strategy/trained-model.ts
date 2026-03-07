import fs from "node:fs";
import path from "node:path";

import type { Prediction } from "../types.js";
import { clamp } from "../utils.js";
import { FEATURE_NAMES, buildFeatureVector } from "./features.js";

export interface TrainedModelArtifact {
  modelType: "logreg_v1";
  symbol: string;
  horizonMin: number;
  trainedAt: string;
  featureNames: string[];
  means: number[];
  stds: number[];
  weights: number[];
  bias: number;
  metrics?: Record<string, number>;
  trainRange?: {
    start: string;
    end: string;
  };
}

function sigmoid(x: number): number {
  if (x > 30) return 1;
  if (x < -30) return 0;
  return 1 / (1 + Math.exp(-x));
}

export function resolveModelPath(filePath: string): string {
  return path.resolve(filePath);
}

export function loadTrainedModel(filePath: string): TrainedModelArtifact | null {
  try {
    const p = resolveModelPath(filePath);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as TrainedModelArtifact;

    if (parsed.modelType !== "logreg_v1") return null;
    if (!Array.isArray(parsed.featureNames) || !Array.isArray(parsed.means) || !Array.isArray(parsed.stds) || !Array.isArray(parsed.weights)) {
      return null;
    }
    if (parsed.featureNames.length !== FEATURE_NAMES.length) return null;
    if (parsed.weights.length !== FEATURE_NAMES.length) return null;
    if (parsed.means.length !== FEATURE_NAMES.length) return null;
    if (parsed.stds.length !== FEATURE_NAMES.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveTrainedModel(filePath: string, artifact: TrainedModelArtifact): void {
  const p = resolveModelPath(filePath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(artifact, null, 2), "utf8");
}

export function predictWithTrainedModel(closes: number[], model: TrainedModelArtifact): Prediction | null {
  const x = buildFeatureVector(closes);
  if (!x) return null;

  const z = x.reduce((acc, xi, idx) => {
    const std = Math.max(1e-9, model.stds[idx]);
    const norm = (xi - model.means[idx]) / std;
    return acc + norm * model.weights[idx];
  }, model.bias);

  const probUp = clamp(sigmoid(z), 0.01, 0.99);
  const confidence = clamp(Math.abs(probUp - 0.5) * 2, 0, 1);

  return {
    probUp,
    confidence,
    modelScore: z,
    modelName: "trained_logreg_v1",
  };
}
