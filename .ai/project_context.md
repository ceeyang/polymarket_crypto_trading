# Project Context: Polymarket Crypto Trading Bot

## Overview
这是一个基于 TypeScript 的 Polymarket 自动化交易机器人，专注于高赔率的“深水区对冲”策略。

## Current Phase
- **Phase 1: Dual-Side Laddering (Implemented)**: 5m/15m/1h 周期的双边网格挂单。
- **Phase 2: High Win-Rate Sprint (Refined)**: 临近结算（如 60s）时，利用 WebSocket 实时价格在价格区间（如 0.95-0.99）进行“扫尾”冲刺买入。
- **Phase 3: Real-time Price Monitoring (Implemented)**: 引入 WebSocket 监听。

## Core Tech Stack
- **Language**: TypeScript (ESM)
- **Runtime**: Node.js (v25+)
- **Trading SDK**: `@polymarket/clob-client`, `@polymarket/builder-relayer-client`
- **Networking**: Axios for REST, `ws` library for market channel updates (`wss://ws-subscriptions-clob.polymarket.com/ws/market`).

## Architecture
- `src/index.ts`: 主入口，包含多周期轮询主循环。
- `src/clients/`: API 客户端（Gamma for discovery, Polymarket for trading）。
- `src/services/`: 业务逻辑模块（StateStore, ClaimService, RealtimePriceService）。
- `config/runtime.json`: 可动态重载的项目配置。

## Specific Rules
- **策略核心**: 必须维持极低价挂单（0.01~0.10），依靠“双爆仓”实现百倍利润对冲磨损。
- **资金管理**: 通过 `officialPnlUsd` 衡量真实盈亏，不依赖虚幻挂单数据。
- **性能优化**: 核心循环频率设为 1s 以匹配精准入场点，WebSocket 监听用于实时价格参考。
