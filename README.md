# Polymarket Dual-Side Multi-Horizon Bot

一个基于 TypeScript 的 Polymarket 双边挂单机器人。

当前版本只做一件事：

- 可同时启用多个币种的 `5m / 15m / 1h` 盘口
- 每个盘口当前周期内，只下单一次
- `YES` 和 `NO` 都按当前配置的多档价格与份数同时挂单，默认两档：`$0.02 x 10`、`$0.01 x 20`
- 盘口结束后自动撤销未成交余单
- 已成交仓位等待官方结果结算
- 按固定间隔自动赎回收益
- 是否模拟下单以 `config/runtime.json` 当前配置为准

## 启动

```bash
pnpm install
cp .env.example .env
pnpm run dev
```

常用命令：

```bash
pnpm run dev
pnpm run bot
pnpm run web
pnpm run balance
pnpm run claim
pnpm run build
```

## 环境变量

交易相关：

- `PRIVATE_KEY`
- `FUNDER_ADDRESS`
- `POLY_API_KEY`
- `POLY_API_SECRET`
- `POLY_API_PASSPHRASE`
- `SIGNATURE_TYPE`

赎回相关：

- `POLY_BUILDER_API_KEY`
- `POLY_BUILDER_SECRET`
- `POLY_BUILDER_PASSPHRASE`
- `RELAYER_TX_TYPE`

## 当前下单策略

- 周期：`5m / 15m / 1h`
- 默认每边双档挂单：`$0.02 x 10`、`$0.01 x 20`
- 支持在 WebUI 自定义多笔挂单
- 每个目标每个盘口只执行一次
- 盘口结束后撤销未成交余单

价格和份数可以在 WebUI 里修改，保存后下一轮立即生效。

## 可配置项

位于 [config/runtime.json](/Users/cee/Desktop/codex/polymarket_crypto_trading/config/runtime.json)：

- `runtime.dryRun`
- `runtime.pollIntervalSec`
- `runtime.autoClaim`
- `runtime.claimIntervalSec`
- `strategy.orderEntries`
- `strategy.targets`
- `network.*`

## WebUI

当前 WebUI 提供：

- 模拟 / 实盘切换
- 轮询间隔与自动赎回间隔
- 多笔挂单价格与份数梯子
- 多币种多周期目标启停
- 最近周期执行记录
- 交易记录
- 运行日志
- 余额刷新 / 手动赎回
- 扫描开关

## 当前示例配置

当前仓库里的 [config/runtime.json](/Users/cee/Desktop/codex/polymarket_crypto_trading/config/runtime.json) 示例值：

- 默认保留 `BTC / ETH / SOL / XRP / DOGE / BNB / HYPE` 的多周期目标列表
- `strategy.orderEntries=[{price:0.02,shareSize:10},{price:0.01,shareSize:20}]`
- `dryRun=false`
- `pollIntervalSec=20`
- `autoClaim=true`
- `claimIntervalSec=300`

上线前请先确认 `dryRun` 是否符合你的预期。

## 验证

上线前至少执行：

```bash
pnpm exec tsc -p tsconfig.json --noEmit
pnpm run build
```
