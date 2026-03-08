const webPort = Number(process.env.WEB_PORT || 8787);
const webUrl = `http://127.0.0.1:${webPort}`;

// 必须先设置，再加载模块；否则 index.ts 会先读取到默认值并继续输出终端日志。
if (process.env.LOG_TO_STDOUT == null) {
  process.env.LOG_TO_STDOUT = "0";
}

const { startServer } = await import("./web.js");
const { startBot } = await import("./index.js");

const server = startServer(webPort, { silent: true });
console.log(webUrl);

startBot().catch((err) => {
  console.error("fatal error", err);
  server.close(() => process.exit(1));
});

