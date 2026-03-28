# Polymarket Dual-Side Multi-Horizon Bot

一个基于 TypeScript 的 Polymarket 双边挂单机器人。

当前版本只做一件事：

- 可同时启用多个币种的 `5m / 15m / 1h` 盘口
- 每个盘口当前周期内，只下单一次
- `YES` 和 `NO` 都按当前配置的多档价格与份数同时挂单，默认三档阶梯：`$0.10 x 15`、`$0.05 x 20`、`$0.02 x 50`
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
- `WEB_PASSWORD`
- `WEB_SESSION_TTL_MS`（可选）
- `WEB_SECURE_COOKIE`（可选，HTTPS 部署时建议开启）
- `POLY_API_KEY`
- `POLY_API_SECRET`
- `POLY_API_PASSPHRASE`
- `SIGNATURE_TYPE`

赎回相关：

- `POLY_BUILDER_API_KEY`
- `POLY_BUILDER_SECRET`
- `POLY_BUILDER_PASSPHRASE`
- `RELAYER_TX_TYPE`

## 核心交易策略逻辑模型（极高赔率·吃针策略）

本 Bot 的核心指导思想**不是判断趋势**，而是专攻极高赔率的“低概率双边吃针事件”。
- Polymarket `5m / 15m / 1h` 预测盘口具备到期归零（或归壹）的特性，结算总和必定为 `1.0`。
- 我们通过 WebUI 设置极深的安全垫阶梯（如 `$0.02 / $0.01`），**在当前周期内同挂 YES 和 NO 两个方向**的网格单。
- 只要其中一方向归零/归壹，靠近结算时，**弱势方必然会触发我们的极低价位接单**，导致**必有一方吃单亏损**。这是此策略的**固定过路费/磨损**。
- **获胜条件：** 只有在极短时间内爆发极端的双向插针（V型反转剧烈震荡），导致我们的两个极低买单（如 YES 和 NO 都在 0.01 被吃）全部被撮合。这就是**完美双边/胜利对冲**。
- 一旦产生双边吃单，最终结算必有一边获得 `1.0` 的 100 倍级别赔付，依靠一次 100x 的胜利覆盖以往 90 多次单边磨损的成本。这就是本项目追求的终极**低频极高赔率事件**。

**当前执行细则：**
- 周期：`5m / 15m / 1h`
- 默认每边多档阶梯挂单，支持在 WebUI 自定义（建议挂 `$0.01 ~ $0.05` 的阶梯）
- 每个目标在每个盘口内，**只执行一次全阵列挂单拦截**
- 盘口结束后会自动撤销未成交的余单，自动结算（或通过 Web 触发赎回）释放资金回流

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

- 登录页密码保护
- 模拟 / 实盘切换
- 轮询间隔与自动赎回间隔
- 多笔挂单价格与份数梯子
- 多币种多周期目标启停
- 最近周期执行记录
- 交易记录
- 运行日志
- 余额刷新 / 手动赎回
- 扫描开关

如果设置了 `WEB_PASSWORD`，访问 `/` 时会先进入登录页；登录成功后才能查看和操作 Web 控制台。这个保护只作用于 Web 访问层，不影响后台 bot 的持续运行。

## 当前示例配置

当前仓库里的 [config/runtime.json](/Users/cee/Desktop/codex/polymarket_crypto_trading/config/runtime.json) 示例值：

- 默认保留 `BTC / ETH / SOL / XRP / DOGE / BNB / HYPE` 的多周期目标列表
- `strategy.orderEntries=[{price:0.10,shareSize:15},{price:0.05,shareSize:20},{price:0.02,shareSize:50}]`
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
