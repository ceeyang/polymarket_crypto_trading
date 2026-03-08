# Polymarket 多盘口预测交易机器人 (TypeScript)

这是一个从零开始的 TypeScript 自动交易项目：
- 市场：Polymarket 上加密货币短周期（二元 Yes/No）盘口
- 支持：BTC / ETH / SOL / XRP，5m / 15m / 1h（最多 12 个盘口目标）
- 数据：Binance 1m K线（训练型 Logistic Regression）
- 执行：Polymarket CLOB `@polymarket/clob-client`
- 收益领取：官方 relayer `@polymarket/builder-relayer-client`

## 功能

- 自动发现多币种多周期盘口（当前窗口优先）
- 计算未来短周期上涨概率（强制使用训练模型）
- 对比市场隐含概率，判断是否有 edge
- 目标化配置：每个目标可独立启用/停用（默认开启 BTC_5m、ETH_5m）
- 风控：
  - 最小 edge 阈值
  - 单笔下注金额上下限
  - 市场流动性过滤
  - 冷却时间
  - 每个 market 只交易一次（本地状态持久化）
- 默认按实盘模式运行（`DRY_RUN=false`）

## 快速开始

```bash
npm install
cp .env.example .env
# 编辑 .env（仅密钥）
# 编辑 config/runtime.json（交易与训练参数）
pnpm run train:model
pnpm run dev
```

`pnpm run dev` 会同时启动：
- Bot 主循环
- Web 控制台（默认 `http://127.0.0.1:8787`）

仅启动 Web：
```bash
pnpm run web
```

仅启动 Bot：
```bash
pnpm run bot
```

查询余额：
```bash
pnpm run balance
```

领取收益：
```bash
pnpm run claim
```

生产构建：
```bash
npm run build
npm start
```

## 训练模型

训练 5 分钟方向分类模型（Logistic Regression）：

```bash
pnpm run train:model
```

按 target 训练（示例）：
```bash
pnpm run train:model -- --target BTC_5m
pnpm run train:model -- --target ETH_15m
pnpm run train:model -- --all-targets
```

训练完成后会输出模型文件（默认）：
- `state/models/eth_5m_logreg.json`

实盘运行：
- 在 `config/runtime.json` 配置 `training.modelOut` 与 `prediction.trainedModelPath`
- 在 `.env` 填好 `PRIVATE_KEY / FUNDER_ADDRESS / POLY_API_*`
- 然后运行 `pnpm run dev`

余额与收益：
- `pnpm run balance`：查询账户余额、仓位和可领取仓位
- `pnpm run claim`：通过官方 relayer 执行 `redeemPositions`（支持 Proxy/Safe 路径）
- 仅领取指定 conditionId：`pnpm run claim -- <conditionId1> <conditionId2>`
- 机器人循环内可自动领取：`runtime.autoClaim=true`，并通过 `runtime.claimCooldownSec` 控制间隔
- 运行日志会写入：`state/runtime.log`（Web 面板可查看）

## 轮次统计

机器人每轮循环结束都会打印统计：
- `totalTrades`：累计交易总数
- `settledTrades`：已结算（可判定输赢）交易数
- `wins`：已结算胜场
- `winRate`：已结算胜率（百分比）

## 配置位置

- `.env`：密钥与关键执行参数（`PRIVATE_KEY / FUNDER_ADDRESS / SIGNATURE_TYPE / RELAYER_TX_TYPE / POLY_API_* / POLY_BUILDER_*`）
- `config/runtime.json`：全部交易、市场筛选、网络与训练参数

关键参数示例（`config/runtime.json`）：
- `runtime.dryRun`
- `runtime.autoClaim / runtime.claimCooldownSec`
- `prediction.trainedModelPath`
- `prediction.minEdge / baseBetUsd / maxBetUsd / minOrderShares`
- `prediction.targets`（最多 12 个）
  - 每项支持：`enabled / coin / horizonMin / symbol / modelPath`
  - 每项可选训练覆盖：`trainStart / trainEnd / trainLookbackMin / trainStepMin / trainValDays / trainEpochs / trainLearningRate / trainL2 / trainPatience`
  - 建议每个 target 使用独立 `modelPath`，避免模型错配
- 训练脚本会按周期自动使用不同默认超参（5m/15m/1h），并允许 target 级覆盖
- `network.signatureType / chainId / rpcUrl / usdcAddress / ctfAddress`
  - 可选：`network.rpcUrls`（数组），`claim` 会自动探测并切换到可用节点
  - `network.relayerHost`

`.env` 关键参数：
- `SIGNATURE_TYPE`：`0=EOA`, `1=polyProxy`, `2=Gnosis Safe`（默认 `2`）
- `RELAYER_TX_TYPE`：支持 `0/1/2` 或 `PROXY/SAFE`（默认 `2 => SAFE`）
- `training.start / end / modelOut`

## 风险提示

- 短线预测波动极大，本项目不保证收益。
- 如需先演练，可在 `config/runtime.json` 里把 `runtime.dryRun` 设为 `true`。
- 请自行确保合规、税务与资金安全。
