import "dotenv/config";

const webPort = Number(process.env.WEB_PORT || 8787);
const webUrl = `http://127.0.0.1:${webPort}`;

// 必须先设置，再加载模块；否则 index.ts 会先读取到默认值并继续输出终端日志。
if (process.env.LOG_TO_STDOUT == null) {
  process.env.LOG_TO_STDOUT = "0";
}
process.env.BOT_CONTROL_MODE = "web";

const { startServer } = await import("./web.js");
const { startBot } = await import("./index.js");
const { writeBotControlState } = await import("./services/bot-control.js");

// Web 控制模式下，默认要求手动点击“开始扫描”才执行交易循环。
writeBotControlState(false, "dev_startup");

const server = startServer(webPort, { silent: true });
console.log(webUrl);

startBot({ controlMode: "WEB_CONTROLLED" }).catch((err) => {
  console.error("fatal error", err);
  server.close(() => process.exit(1));
});
