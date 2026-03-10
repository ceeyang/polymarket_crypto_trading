# Polymarket 多盘口预测交易机器人（TypeScript）

一个围绕 Polymarket 加密货币 Up/Down 盘口构建的实盘/模拟两用机器人，支持多币种多周期并行扫描、模型训练与回测、Web 控制台可视化运维。

## 1. 项目目标

- 交易标的：Polymarket 的 BTC/ETH/SOL/XRP Up/Down 盘口。
- 周期支持：`5m / 15m / 1h`（最多 12 个盘口目标并行）。
- 预测方式：训练好的 Logistic Regression 模型（只用训练模型，不走手工规则预测）。
- 执行方式：CLOB 限价挂单（默认 GTC）。
- 收益领取：官方 Relayer（`@polymarket/builder-relayer-client`）。

## 2. 当前核心能力（与代码一致）

- 多目标扫描：每轮按配置扫描启用盘口目标（如 `BTC_5m`、`ETH_15m`）。
- 仅交易“当前时间窗口”盘口：
  - 按周期边界对齐（5m 例：`00:00~00:05, 00:05~00:10`）。
  - 盘口 `endDate` 与当前周期理论结束时间误差容忍 15 秒。
- 单目标开盘窗口入场：
  - 由 `prediction.cycleStartWindowSec` 控制，仅在每个周期开始后的前 N 秒允许挂单。
- 固定价格挂单：
  - 使用 `prediction.fixedOrderPrice` 作为挂单价格（支持输入 `45` 自动转 `0.45`）。
- 单笔实际花费上限控制：
  - 用 `prediction.maxOrderNotionalUsd` 控制实际最大花费，份额按 `notional / price` 计算。
- 防重复交易：
  - 同一 `marketId` 只尝试一次（持久化到 `state/bot-state.json`）。
  - 同一 target 在同一周期内有锁，不重复下单。
- 订单跟踪与过期清理：
  - 周期结束后，若前一盘口订单仍未成交（`matchedSize=0`），自动撤单并标记取消。
- 交易结果判定：
  - 优先用 Polymarket 官方盘口最终价格（side outcome price）与入场价比较：
    - `finalPrice > entryPrice => WIN`
    - 否则 `LOSE`
  - 辅助回退到官方 closed positions 信息。
- 自动领取收益：
  - 后台异步执行，不阻塞主扫描。
  - 支持并发（`maxConcurrency`）。
- 风控：
  - `maxOpenTrades`、`maxTradesPerDay`、`maxConsecutiveLosses`。
  - `maxDrawdownPct`（最大回撤）：
    - Web 控制模式：暂停扫描（不退出 Web）。
    - 独立 bot 模式：触发后退出进程。

## 3. 目录结构

```text
.
├─ config/
│  └─ runtime.json                # 运行配置（非密钥）
├─ src/
│  ├─ index.ts                    # Bot 主循环
│  ├─ dev.ts                      # 一键启动 Web + Bot（Web 控制模式）
│  ├─ bot.ts                      # 仅启动 Bot（独立模式）
│  ├─ web.ts                      # Web API + 页面服务
│  ├─ web-ui/index.html           # 控制台前端
│  ├─ train-model.ts              # CLI 训练入口
│  ├─ balance.ts                  # 余额查询
│  ├─ claim.ts                    # 领取收益
│  ├─ clients/                    # Binance/Gamma/Polymarket 客户端
│  ├─ services/                   # 回测、模型工厂、领取、状态存储等
│  └─ strategy/                   # 特征、模型推理、下单决策
├─ state/
│  ├─ bot-state.json              # 交易记录与市场去重状态
│  ├─ runtime.log                 # 运行日志
│  ├─ model-profiles.json         # 模型工厂配置
│  ├─ bot-control.json            # Web 扫描开关状态
│  └─ models/*.json               # 训练后模型
└─ .env                           # 仅密钥与签名类型
```

## 4. 安装与启动

### 4.1 安装

```bash
pnpm install
cp .env.example .env
```

### 4.2 填写密钥（`.env`）

仅保留关键密钥类字段，详见第 6 节。

### 4.3 启动模式

1. `pnpm run dev`
   - 启动 Web + Bot（`WEB_CONTROLLED`）。
   - 控制台只输出 Web 地址（例如 `http://127.0.0.1:8787`）。
   - 详细日志写入 Web 日志页与 `state/runtime.log`。
   - 默认**不自动扫描**，需在 Web 顶部开关手动开始。
2. `pnpm run bot` 或 `pnpm run bot:only`
   - 仅启动 Bot（`STANDALONE`）。
   - 启动即扫描，不受 Web 开关影响。
3. `pnpm run web`
   - 仅启动 Web（不带 bot 主循环）。

## 5. 常用命令

```bash
# 启动（推荐）
pnpm run dev

# 仅 Bot
pnpm run bot

# 余额
pnpm run balance

# 显示 allowances 明细
pnpm run balance -- --show-allowances

# 领取全部可领收益
pnpm run claim

# 仅领取指定 conditionId（可多个）
pnpm run claim -- 0xabc... 0xdef...

# 训练（默认启用目标）
pnpm run train:model

# 训练指定目标
pnpm run train:model -- --target BTC_5m

# 训练全部目标
pnpm run train:model -- --all-targets
```

## 6. 环境变量说明（`.env`）

`.env.example` 为最小集合：

- `PRIVATE_KEY`
  - 交易签名私钥（必须）。
- `FUNDER_ADDRESS`
  - 资金地址（可选；Safe/Proxy 场景常用）。
- `POLY_API_KEY / POLY_API_SECRET / POLY_API_PASSPHRASE`
  - CLOB L2 API 密钥（可选）。
  - 若为空，程序会尝试从私钥派生。
  - 若填写但与当前 signer/profile 不匹配，会自动回退派生。
- `SIGNATURE_TYPE`
  - CLOB 签名类型：`0=EOA`，`1=polyProxy`，`2=Gnosis Safe`。
- `POLY_BUILDER_API_KEY / POLY_BUILDER_SECRET / POLY_BUILDER_PASSPHRASE`
  - Relayer 赎回需要（`pnpm run claim` / Web 赎回按钮）。
- `RELAYER_TX_TYPE`
  - Relayer 交易类型：`SAFE` 或 `PROXY`（也兼容 `0/1/2`，内部归一化）。

## 7. 运行配置说明（`config/runtime.json`）

### 7.1 `runtime`

- `dryRun`：`true` 模拟单，`false` 实盘。
- `pollIntervalSec`：主循环轮询间隔（秒）。
- `autoClaim`：是否自动赎回收益。
- `claimCooldownSec`：自动赎回最小间隔（秒）。
- `maxDrawdownPct`：最大回撤（0=关闭）。
- `maxOpenTrades`：最大未结算交易数（0=关闭）。
- `maxTradesPerDay`：当日最大交易数（0=关闭）。
- `maxConsecutiveLosses`：最大连续亏损（0=关闭）。

### 7.2 `prediction`（当前下单模式关键参数）

- `minEdge`：最小 edge 阈值（小于即跳过）。
- `fixedOrderPrice`：固定挂单价格（0~1；输入 45 自动按 0.45）。
- `maxOrderNotionalUsd`：单笔最大实际花费（美元）。
- `cycleStartWindowSec`：每周期开始后允许挂单的窗口秒数。
- `targets`：盘口目标列表（最多 12）。
  - `id`：目标 ID（如 `BTC_5m`）。
  - `enabled`：是否启用。
  - `coin`：`BTC/ETH/SOL/XRP`。
  - `horizonMin`：`5/15/60`。
  - `symbol`：训练/回测行情交易对（如 `BTCUSDT`）。
  - `modelPath`：该盘口使用的模型文件路径。

说明：
- 早期遗留字段（如 `baseBetUsd`、`maxBetUsd`、`minOrderShares`、`priceAggression`、`minEntryPrice`、`maxEntryPrice`、`minOverround`、`maxOverround`、`enableReverseFallback` 等）目前不作为固定价格模式的主决策条件。当前核心下单逻辑以上述四项为准。

### 7.3 `marketFilter`

- `minMarketLiquidity`：盘口最小流动性过滤。
- `minTimeToExpiryMin` / `maxTimeToExpiryMin`：候选盘口剩余时长范围。

### 7.4 `network`

- `polyHost` / `gammaHost` / `dataApiHost` / `relayerHost`：API 主机。
- `rpcUrl` / `rpcUrls`：链上 RPC（claim 时自动探测可用 RPC）。
- `chainId` / `signatureType` / `usdcAddress` / `ctfAddress`。

### 7.5 `training`

CLI 训练默认参数（模型工厂可覆盖）：
- `symbol/start/end/horizonMin/lookbackMin/stepMin/valDays/epochs/learningRate/l2/patience/modelOut`

## 8. 下单逻辑（逐步）

每轮（默认 20 秒）流程如下：

1. 读取最新配置与扫描开关状态。
2. 同步 live 订单状态，更新 `matchedSize/orderStatus`。
3. 清理“前一盘口未成交单”：
   - 如果盘口已到期且仍未成交，自动撤单并标记 `CANCELED_PREV_MARKET_UNFILLED`。
4. 同步已到结算时间的交易结果（官方数据）。
5. 风控检查（回撤、未结算数、日内交易数、连续亏损）。
6. 对每个启用目标：
   - 扫描候选盘口。
   - 只选“当前时间窗口”有效盘口。
   - 读取对应模型并预测 `probUp`。
   - 计算 edge，未达阈值跳过。
   - 检查是否在开盘窗口内。
   - 检查是否被动挂单（limit 必须低于当前边价格减 tick buffer）。
7. 满足条件则下限价单并记录交易。
8. 进入下一轮。

## 9. “只在开盘前 1 分钟内挂单”如何实现

以 5m 周期、`cycleStartWindowSec=60` 为例：

- 周期总时长 300 秒。
- 仅当 `remainingSeconds >= 240` 才允许下单。
- 即只在每个 5 分钟周期刚开始的前 60 秒内入场。

15m/1h 同理，按周期长度自动换算。

## 10. 交易记录与状态来源

交易记录保存在 `state/bot-state.json`，Web 交易页展示该文件内容并附加盘口跳转链接。

状态要点：

- `executionMode`：`LIVE` / `DRY_RUN`。
- `orderStatus`：`OPEN`、`CANCELED_PREV_MARKET_UNFILLED` 等。
- `matchedSize`：实际成交份额。
- `settlementSource`：
  - `POLYMARKET_MARK_PRICE`：以盘口最终价格判定。
  - `POLYMARKET_OFFICIAL`：官方仓位/结算信息回填。

胜负判定（当前）：
- 以最终 side 价格与入场价对比：`final > entry => WIN`，否则 `LOSE`。

## 11. Web 控制台模块

顶部 Tab：

1. 运行配置
   - 参数编辑、盘口启用开关、每盘口模型选择、保存生效。
2. 交易记录
   - 分页、筛选、胜率统计、清空交易记录。
   - 盘口标题可点击跳转 Polymarket 页面。
3. 运行日志
   - 实时 tail、清空日志。
4. 模型工厂
   - 初始化默认模型、创建/保存/训练/删除模型。
5. 回测模块
   - 单模型详细回测、模型对比回测。

顶部全局：
- 扫描开关（醒目状态）。
- 余额刷新。
- 赎回收益按钮。

## 12. 模型工厂参数解释

- `训练目标`
  - 选择要训练的盘口（如 `BTC-5M`）。
- `模型名称`
  - 仅用于 UI/管理标识。
- `训练天数`
  - 训练样本历史窗口长度（天）。
- `lookback(分钟)`
  - 每个样本向前看的行情窗口长度（特征输入长度）。
- `step(分钟)`
  - 样本抽样步长（时间下采样，减小样本相关性与训练开销）。
- `valDays`
  - 末尾验证集天数（按时间切分，不打乱）。
- `epochs`
  - 最大训练轮数。
- `learningRate`
  - 梯度下降学习率。
- `L2`
  - 权重正则化强度。
- `patience`
  - 早停容忍轮数（验证损失不提升即提前停止）。
- `模型输出路径`
  - 模型 JSON 保存路径；可被盘口绑定直接用于实盘。

## 13. 回测说明

### 13.1 回测天数限制

- 5m：`1 / 3 / 7` 天
- 15m：`1 / 3 / 7 / 15` 天
- 1h：`1 / 3 / 7 / 15` 天

### 13.2 样本时间规则

- 严格按 Polymarket 周期边界取样（如 5m 只取 `xx:00/05/10...`）。
- 标签规则与盘口一致：`futureClose >= entryClose => UP`。

### 13.3 关键指标定义

- `样本数`：参与评估的总样本。
- `模型胜率`：不加交易阈值时，方向预测胜率。
- `交易次数`：`edge >= minEdge` 的样本数（会触发交易信号）。
- `交易胜率`：只统计触发交易信号样本的胜率。
- `交易出现率`：`交易次数 / 样本数`。
- `最大连续错误`：
  - `maxConsecutivePredictionLosses`：预测连续错最大值。
  - `maxConsecutiveTradeLosses`：交易信号子集内连续错最大值。

## 14. 数据文件说明

- `state/runtime.log`：运行日志（Web 日志页读取）。
- `state/bot-state.json`：交易记录、已尝试 marketId 集合。
- `state/model-profiles.json`：模型工厂配置与训练状态。
- `state/bot-control.json`：Web 扫描开关状态。
- `state/config.reload.signal`：配置热加载信号。

## 15. 常见问题排查

### 15.1 `Unauthorized/Invalid api key`

- 说明填入的 `POLY_API_*` 与当前 signer/funder 组合不匹配。
- 处理：
  - 清空 `POLY_API_*` 让程序自动派生。
  - 或确认 API key 属于当前地址配置。

### 15.2 `pnpm run dev` 退出码 `24`

- 触发了连续亏损熔断（`maxConsecutiveLosses`）。
- 临时关闭可设为 `0`。

### 15.3 订单被取消

- 若显示 `CANCELED_PREV_MARKET_UNFILLED`：
  - 是前一周期订单到期仍未成交，被策略主动清理（预期行为）。

### 15.4 赎回失败

- 检查是否已配置 `POLY_BUILDER_*`。
- 检查 `RELAYER_TX_TYPE` 与账户形态（SAFE/PROXY）是否一致。
- 检查 Polygon RPC 可用性（会自动探测 `network.rpcUrls`）。

## 16. 实盘前检查清单（建议逐条确认）

1. `runtime.dryRun=false`。
2. `prediction.fixedOrderPrice` 与预期一致（例如 `0.4`）。
3. `prediction.maxOrderNotionalUsd` 为你能接受的单笔上限（例如 `2.0`）。
4. `prediction.cycleStartWindowSec` 设置合理（避免临近到期追单）。
5. 仅启用你希望交易的目标（`targets[].enabled`）。
6. 每个启用目标绑定了正确模型（`targets[].modelPath`）。
7. Web 模式下手动开启扫描；独立 bot 模式默认自动扫描。
8. `maxDrawdownPct`、`maxOpenTrades`、`maxTradesPerDay` 已设置为可承受范围。
9. 先用 `dryRun` 和回测验证逻辑，再切实盘。

## 17. 风险与免责声明

- 本项目不承诺收益，短周期二元市场波动与滑点风险极高。
- 任何参数都可能在实盘中失效，必须持续监控。
- 请自行承担合规、税务与资金安全责任。
