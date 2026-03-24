# Polymarket AI 15m Bot

一个基于 TypeScript 的 Polymarket 交易机器人。

当前版本保留了原有的：

- Polymarket 下单执行层
- 订单同步与结算逻辑
- Web 控制台
- 状态持久化与风控

但已经移除原有训练模型、模型工厂、回测与本地预测模型链路，改为：

- 只做 `15m` 周期
- 用 LLM 读取“事实包”后输出结构化方向判断
- 支持多个 OpenAI 模型
- 支持 OpenAI-compatible 其他厂商
- 默认 `dryRun=true`，先跑模拟单

## 目录

```text
.
├─ config/runtime.json       # 运行配置
├─ src/
│  ├─ index.ts               # Bot 主循环
│  ├─ dev.ts                 # Web + Bot
│  ├─ bot.ts                 # 仅 Bot
│  ├─ web.ts                 # Web API + 页面
│  ├─ clients/               # Binance / Gamma / Polymarket 客户端
│  ├─ services/
│  │  ├─ ai-predictor.ts     # 单模型 LLM 调用
│  │  ├─ market-facts.ts     # 事实包组装
│  │  ├─ state-store.ts      # 本地状态
│  │  └─ claim-service.ts    # 收益赎回
│  ├─ strategy/decision.ts   # AI 输出 -> 下单决策
│  └─ web-ui/index.html      # 控制台
├─ state/                    # 本地状态、日志、历史交易
└─ .env.example              # 环境变量模板
```

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

AI 相关：

- `AI_API_KEY`
- `AI_MODEL`
- `AI_BASE_URL`
- `AI_API_TYPE`
- `AI_LABEL`
- `AI_REASONING_EFFORT`
- `AI_TEMPERATURE`
- `AI_MAX_OUTPUT_TOKENS`
- `AI_TIMEOUT_MS`
- `AI_RESPONSE_MODE`

## AI 预测方式

Bot 每轮会为启用目标做这些事：

1. 扫描当前 `15m` 周期对应的 Polymarket Up/Down 市场
2. 从 Binance 获取近段时间 1m K 线
3. 组装事实包
4. 将事实包填入提示词模板
5. 调用一个 LLM 模型
6. 读取结构化输出：
   - `direction`
   - `probUp`
   - `confidence`
   - `tradeable`
   - `summary/reasons/risks`
7. 再结合：
   - `minConfidence`
   - `fixedOrderPrice`
8. 决定是否下单

每个目标在每个 `15m` 周期内只会做一次 AI 分析。无论最终是下单还是跳过，本周期都不会重复调用模型。

## 模型支持

当前支持两类兼容方式：

- `openai_responses`
  - 用于 OpenAI Responses API
- `openai_chat_compatible`
  - 用于 OpenAI-compatible Chat Completions 风格服务

模型配置全部来自 `.env`，不在 WebUI 中编辑。

当前默认按 DeepSeek 配置，最简单写法：

```env
AI_API_KEY=...
AI_MODEL=deepseek-chat
AI_BASE_URL=https://api.deepseek.com
AI_API_TYPE=openai_chat_compatible
AI_LABEL=DeepSeek Primary
```

可配置字段包括：

- `AI_API_KEY`
- `AI_MODEL`
- `AI_BASE_URL`
- `AI_API_TYPE`
- `AI_LABEL`
- `AI_REASONING_EFFORT`
- `AI_TEMPERATURE`
- `AI_MAX_OUTPUT_TOKENS`
- `AI_TIMEOUT_MS`
- `AI_RESPONSE_MODE`

## 关键配置

位于 `config/runtime.json`：

### `runtime`

- `dryRun`
- `pollIntervalSec`
- `autoClaim`
- `claimCooldownSec`
- `maxDrawdownPct`
- `maxOpenTrades`
- `maxTradesPerDay`
- `maxConsecutiveLosses`

### `prediction`

- `horizonMin`
- `factLookbackMinutes`
- `minConfidence`
- `fixedOrderPrice`
- `maxOrderNotionalUsd`
- `systemPrompt`
- `userPromptTemplate`
- `targets`

### `marketFilter`

- `minMarketLiquidity`
- `minTimeToExpiryMin`
- `maxTimeToExpiryMin`
- `minEntrySeconds`

## WebUI

当前 WebUI 提供：

- 运行配置
- AI 模型只读展示
- 提示词编辑
- 15m 目标启停
- 最近 AI 判定与每次模型提交元数据查看
- 交易记录
- 运行日志
- 余额刷新 / 收益赎回
- 扫描开关

## 默认行为

默认配置下：

- 只启用 `BTC_15m`
- `dryRun=true`
- 默认只使用一个 DeepSeek 模型

也就是说，如果你什么都不改，默认是模拟单，不会真实下单。

## 验证

当前代码已通过：

```bash
pnpm exec tsc -p tsconfig.json --noEmit
pnpm run build
```
