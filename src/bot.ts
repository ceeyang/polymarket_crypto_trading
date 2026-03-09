import { startBot } from "./index.js";

startBot({ controlMode: "STANDALONE" }).catch((err) => {
  console.error("fatal error", err);
  process.exit(1);
});
