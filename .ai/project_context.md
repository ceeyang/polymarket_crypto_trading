# Project Context: Polymarket Crypto Trading Bot

## Overview
这是一个基于 TypeScript 的 Polymarket 自动化交易机器人，专注于高赔率的“深水区对冲”策略。

## Current Phase
- **Phase 4: Full System Modularization (Completed)**: 将单体 `index.ts` 重构为基于服务的 SOA 架构。

## Core Tech Stack
- **Language**: TypeScript (ESM)
- **Runtime**: Node.js (v25+)
- **Trading SDK**: `@polymarket/clob-client`, `@polymarket/builder-relayer-client`
- **Networking**: Axios for REST, `ws` library for market channel updates.

## Architecture (Refined)
- `src/index.ts`: 轻量化主入口，负责环境初始化与 `TradingEngine` 驱动。
- `src/clients/`: API 客户端（`GammaClient` 负责发现，`PolymarketTrader` 负责交易）。
- `src/services/trading-engine.ts`: 核心策略驱动器，托管双边对冲与 WebSocket HWR 逻辑。
- `src/services/order-service.ts`: 订单全生命周期同步、撤单与官方对账及结算。
- `src/services/position-service.ts`: 钱包地址解析与链上已平仓仓位追踪。
- `src/services/bot-control.ts`: 负责运行参数热重载、信号读取及界面开关同步。
- `src/types.ts`: 全局业务与状态数据模型的单一来源。
- `config/runtime.json`: 可平滑加载的动态策略配置。

## Specific Rules
- **策略核心**: 必须维持极低价挂单（0.01~0.10），依靠“双爆仓”实现百倍利润对冲磨损。
- **资金管理**: 通过 `officialPnlUsd` 衡量真实盈亏，不依赖虚幻挂单数据。
- **性能优化**: 核心循环频率设为 1s 以匹配精准入场点，WebSocket 监听用于实时价格参考。
