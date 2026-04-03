# Changelog

## [2026-04-03]
### Added
- **RealtimePriceService**: 引入了 WebSocket 实时价格监听服务。
- **WebSocket Compatibility**: 切换至 `ws` 库并添加浏览器模拟 Header（User-Agent/Origin），修复了原生 WebSocket 在部分环境下的握手失败问题。
- **WebSocket Integration**: 自动推导 Polymarket WS 终端并订阅活跃 Target 的 Token 增量订单簿推送。
- **PolymarketTrader Update**: 暴露底层 `ClobClient` 实例，支持高级操作。

### Refined
- **HWR Strategy**: 优化了高胜率冲刺逻辑。在距结算 60s 内，优先从 WebSocket 获取毫秒级实时价格，仅在价格进入 [0.95, 0.99] 安全区间时触发下单，确保“高胜率、稳健扫尾”。
- **RealtimePriceService**: 增加了首次获取价格时的日志打印，便于观察 WebSocket 状态。
