import { startBot } from "./index.js";
import { startServer } from "./web.js";

const server = startServer();

startBot().catch((err) => {
  console.error("fatal error", err);
  server.close(() => process.exit(1));
});

