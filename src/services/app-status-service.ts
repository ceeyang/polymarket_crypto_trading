import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export interface AppVersionInfo {
  version: string;
  commit: string;
  startedAt: string;
}

let _cachedVersion: AppVersionInfo | null = null;

export function getAppVersion(): AppVersionInfo {
  if (_cachedVersion) return _cachedVersion;

  let version = "unknown";
  try {
    const pkgPath = path.resolve("package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    // ignore
  }

  let commit = "unknown";
  try {
    commit = execSync("git rev-parse --short HEAD", { encoding: "utf8", timeout: 3000 }).trim();
  } catch {
    // ignore — no git or not a repo
  }

  _cachedVersion = { 
    version, 
    commit, 
    startedAt: new Date().toISOString() 
  };
  return _cachedVersion;
}
