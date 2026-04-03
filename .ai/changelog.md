# Changelog

## [2026-04-03]
### Added
- **RealtimePriceService**: 引入了 WebSocket 实时价格监听服务。
- **WebSocket Compatibility**: 切换至 `ws` 库并添加浏览器模拟 Header（User-Agent/Origin），修复了原生 WebSocket 在部分环境下的握手失败问题。
- **WebSocket Integration**: 自动推导 Polymarket WS 终端并订阅活跃 Target 的 Token 增量订单簿推送。
- **PolymarketTrader Update**: 暴露底层 `ClobClient` 实例，支持高级操作。

### Modified
- **`src/index.ts`**: 将 `RealtimePriceService` 集成入 `RuntimeContext` 并在主循环中持续更新订阅列表。
- **`src/services/realtime-price.ts`**: 封装了 PING 保活、重连机制及消息处理。
