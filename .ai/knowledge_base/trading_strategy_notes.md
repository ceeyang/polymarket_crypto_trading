# Trading Strategy Notes & Pitfalls

## 1. 最小下单限制 (Minimum Order Size)
- **问题**: Polymarket CLOB 对订单份额（Shares）有最小限制（通常为 5 份）。
- **现象**: 如果按照 `USD / Price` 计算出的 `size < 5`，订单会被拒绝（Status 400）。
- **对策**: 在 `TradingEngine` 中已实现兜底逻辑：如果计算出的 `size < 5`，则强制使用 `5` 作为下单份数，确保订单能够进入队列。

## 2. 合约精度与 Tick Size
- **细节**: 在下单时必须尊从市场的 `tickSize`（通常为 0.01）。
- **实战**: 所有下单价格需使用 `toFixed(6)` 或 `Number.isFinite` 校验，避免发送过长或非法的浮点数导致请求失败。

## 3. 双边对冲触发时机
- **模式**: 系统倾向于在周期开始（Main Loop 发现新市场）立即按阶梯挂单，而非等待价格波动。
- **目标**: 专博瞬时“V型插针”。如果等到价格已经波动后再挂单，往往会错过最佳的极高赔率吃单点。

## 4. 钱包地址确定性 (Address Resolution)
- **逻辑**: 对于多链或多个 Key 的环境，必须通过 `pickUserAddress` 统一获取当前活跃的 Polygon 地址。
- **持久化**: 收益赎回（Claim）依赖于对该地址的历史仓位扫描，因此地址的统一性至关重要。
