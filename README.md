# ETH 5分钟预测交易机器人 (TypeScript)

这是一个从零开始的 TypeScript 自动交易项目：
- 市场：Polymarket 上 ETH 短周期（二元 Yes/No）盘口
- 目标：捕捉接近 5 分钟周期的 ETH 涨跌市场并自动下单
- 数据：Binance 1m K线（训练型 Logistic Regression）
- 执行：Polymarket CLOB `@polymarket/clob-client`
- 收益领取：官方 relayer `@polymarket/builder-relayer-client`

## 功能

- 自动发现 ETH 分钟级市场（优先 5 分钟特征 + 临近到期）
- 计算未来短周期上涨概率（强制使用训练模型）
- 对比市场隐含概率，判断是否有 edge
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
npm run dev
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
- `prediction.trainedModelPath`
- `prediction.minEdge / baseBetUsd / maxBetUsd`
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
