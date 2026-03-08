import "dotenv/config";

import { loadConfig } from "./config.js";
import { claimRedeemablePositions } from "./services/claim-service.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const cliIds = process.argv.slice(2).map((x) => x.trim()).filter(Boolean);
  await claimRedeemablePositions(cfg, {
    conditionIds: cliIds,
    logPrefix: "[claim]",
  });
}

main().catch((err) => {
  console.error("[claim] fatal", err instanceof Error ? err.message : err);
  process.exit(1);
});
