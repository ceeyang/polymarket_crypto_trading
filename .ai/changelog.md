# Changelog

## [2026-04-04]
### Refactor (Phase 5: Web & CLI Modularization)
- **Web Orchestrator Separation**: 将单体 `web.ts` 拆解为 `AuthService`, `AccountService`, `LogService`, `WebUtils` 和 `AppStatusService`。
- **AccountService**: 集中处理资产统计、USDC 余额及仓位价值计算，并引入 8s 缓存以减轻 RPC/API 压力。
- **AuthService**: 统一了 Web 端密码校验与会话存储逻辑。
- **LogService**: 实现了异步 Append 逻辑与 Tail 处理，支持在 Web 端查看与清理运行日志。
- **PositionService Enhancement**: 整合了活跃持仓与已平仓追踪，服务于 CLI `balance.ts` 与 Web 界面。
- **CLI Cleanliness**: 重构 `balance.ts` 以调用 Service，移除了千行冗余的业务逻辑代码。

### Refactor (Phase 4: Core Engine Modularization)

## [2026-04-03]
### Added
- **RealtimePriceService**: 引入了 WebSocket 实时价格监听服务。
- **WebSocket Compatibility**: 切换至 `ws` 库并添加浏览器模拟 Header（User-Agent/Origin），修复了原生 WebSocket 在部分环境下的握手失败问题。
- **WebSocket Integration**: 自动推导 Polymarket WS 终端并订阅活跃 Target 的 Token 增量订单簿推送。
- **PolymarketTrader Update**: 暴露底层 `ClobClient` 实例，支持高级操作。

### Refined
- **HWR Strategy**: 优化了高胜率冲刺逻辑。在距结算 60s 内，优先从 WebSocket 获取毫秒级实时价格，仅在价格进入 [0.95, 0.99] 安全区间时触发下单，确保“高胜率、稳健扫尾”。
- **RealtimePriceService**: 增加了首次获取价格时的日志打印，便于观察 WebSocket 状态。
