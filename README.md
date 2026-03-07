# ETH 5分钟预测交易机器人 (TypeScript)

这是一个从零开始的 TypeScript 自动交易项目：
- 市场：Polymarket 上 ETH 短周期（二元 Yes/No）盘口
- 目标：捕捉接近 5 分钟周期的 ETH 涨跌市场并自动下单
- 数据：Binance 1m K线（动量模型）
- 执行：Polymarket CLOB `@polymarket/clob-client`

## 功能

- 自动发现 ETH 分钟级市场（优先 5 分钟特征 + 临近到期）
- 计算未来短周期上涨概率
- 对比市场隐含概率，判断是否有 edge
- 风控：
  - 最小 edge 阈值
  - 单笔下注金额上下限
  - 市场流动性过滤
  - 冷却时间
  - 每个 market 只交易一次（本地状态持久化）
- `DRY_RUN=true` 默认不开实盘

## 快速开始

```bash
npm install
cp .env.example .env
# 编辑 .env
npm run dev
```

生产构建：
```bash
npm run build
npm start
```

## 关键环境变量

- `DRY_RUN=true|false`
- `PRIVATE_KEY`：钱包私钥（实盘必填）
- `SIGNATURE_TYPE`：`0` EOA / `1` Proxy / `2` Safe
- `FUNDER_ADDRESS`：资金地址（EOA 通常填你的地址）
- `MIN_EDGE`：最小优势阈值（默认 0.03）
- `BASE_BET_USD`、`MAX_BET_USD`：仓位控制
- `PRICE_AGGRESSION`：买单相对盘口的提价（默认 0.01）

## 风险提示

- 短线预测波动极大，本项目不保证收益。
- 先 `DRY_RUN=true` 跑几天再考虑实盘。
- 请自行确保合规、税务与资金安全。

