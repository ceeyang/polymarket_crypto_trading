# Project Context: Polymarket Crypto Trading Bot

## Overview
这是一个基于 TypeScript 的 Polymarket 自动化交易机器人，专注于高赔率的“深水区对冲”策略。

## Current Phase
- **Phase 5: Web UI Modularization (Completed)**: 将单体 `web.ts` 重构为基于服务的 SOA 架构。

## Core Tech Stack
- **Language**: TypeScript (ESM)
- **Runtime**: Node.js (v25+)
- **Trading SDK**: `@polymarket/clob-client`, `@polymarket/builder-relayer-client`
- **Networking**: Axios for REST, `ws` library for market channel updates.

## Architecture (Refined)
- `src/index.ts`: 轻量化主入口，负责环境初始化与 `TradingEngine` 驱动。
- `src/web.ts`: 轻量化 Web UI 入口，负责路由分发。
- `src/services/trading-engine.ts`: 核心策略驱动器，托管基础循环与 HWR 逻辑。
- `src/services/auth-service.ts`: Web 身份认证与会话管理。
- `src/services/account-service.ts`: 资金、余额与总资产统计缓存。
- `src/services/log-service.ts`: 运行日志 Tail、清理与持久化。
- `src/services/web-utils.ts`: HTTP 响应、市场 URL 发现与共用格式化组件。
- `src/services/app-status-service.ts`: 应用软件版本与 Git Commit 追踪。
- `src/services/order-service.ts`: 订单同步、撤单与对账结算。
- `src/services/position-service.ts`: 钱包解析、活跃持仓与已平仓追踪。
- `src/services/bot-control.ts`: 热重载信号与界面开关同步。
- `src/types.ts`: 单一模型来源。
- `config/runtime.json`: 策略配置。

## Specific Rules
- **策略核心**: 必须维持极低价挂单（0.01~0.10），依靠“双爆仓”实现百倍利润对冲磨损。
- **资金管理**: 通过 `officialPnlUsd` 衡量真实盈亏，不依赖虚幻挂单数据。
- **性能优化**: 核心循环频率设为 1s 以匹配精准入场点，WebSocket 监听用于实时价格参考。
