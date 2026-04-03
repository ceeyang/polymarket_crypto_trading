import WebSocket from "ws";
import type { Config } from "../config.js";

/**
 * 实时价格信息数据结构
 */
export interface TokenPrice {
  tokenId: string;
  bestBid: number;
  bestAsk: number;
  mid: number;
  lastUpdateAtMs: number;
}

/**
 * 实时价格服务 (WebSocket 实现)
 * 监听 Polymarket CLOB 的增量订单簿推送，维护内存中的最新价格
 */
export class RealtimePriceService {
  private ws: WebSocket | null = null;
  private watchedTokenIds = new Set<string>();
  private prices = new Map<string, TokenPrice>();
  private connected = false;
  private reconnectTimer: any = null;
  private pingTimer: any = null;
  public onPriceUpdate?: (price: TokenPrice) => void;

  constructor(private readonly config: Config) { }

  /**
   * 启动 WebSocket 服务
   */
  async start(): Promise<void> {
    this.connect();
  }

  /**
   * 停止 WebSocket 服务
   */
  stop(): void {
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {
        this.ws.close();
      }
      this.ws = null;
    }
    this.connected = false;
  }

  /**
   * 添加需要监听的 Token
   */
  watchTokens(tokenIds: string[]): void {
    const newIds = tokenIds.filter(id => id && !this.watchedTokenIds.has(id));
    if (newIds.length === 0) return;

    for (const id of newIds) {
      this.watchedTokenIds.add(id);
    }

    if (this.connected && this.ws) {
      this.subscribe(newIds);
    }
  }

  /**
   * 获取特定 Token 的最新价格
   */
  getPrice(tokenId: string): TokenPrice | undefined {
    return this.prices.get(tokenId);
  }

  /**
   * 获取所有已缓存的价格
   */
  getAllPrices(): TokenPrice[] {
    return Array.from(this.prices.values());
  }

  private connect(): void {
    this.clearTimers();

    // 根据官方文档，Public Market Data 终端为：
    // wss://ws-subscriptions-clob.polymarket.com/ws/market
    const wsHost = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

    console.log(`[realtime-price] connecting to ${wsHost}`);

    try {
      this.ws = new WebSocket(wsHost, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Origin": "https://polymarket.com"
        },
        handshakeTimeout: 10000
      });

      this.ws.on("open", () => {
        console.log("[realtime-price] websocket connected to market channel");
        this.connected = true;
        this.startPing();
        this.resubscribeAll();
      });

      this.ws.on("close", (code, reason) => {
        console.warn(`[realtime-price] websocket closed code=${code} reason=${reason}, reconnecting in 5s...`);
        this.connected = false;
        this.scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        console.error("[realtime-price] websocket error:", err.message || err);
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on("ping", () => {
        if (this.ws) this.ws.pong();
      });

    } catch (err) {
      console.error("[realtime-price] failed to initiate websocket connection", err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.clearTimers();
    this.reconnectTimer = setTimeout(() => this.connect(), 5000);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.connected && this.ws) {
        // Polymarket WS keeps alive with PING
        this.ws.ping();
      }
    }, 10000);
  }

  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data);

      // 处理 book (初始快照) 或 best_bid_ask (实时更新) 或 price_change
      const eventType = msg?.event_type || msg?.type;

      if (eventType === "book" || eventType === "best_bid_ask" || eventType === "price_change") {
        const tokenId = msg.asset_id;
        if (!tokenId) return;

        let bid = 0;
        let ask = 0;

        if (eventType === "best_bid_ask") {
          bid = Number(msg.best_bid || 0);
          ask = Number(msg.best_ask || 0);
        } else if (eventType === "book") {
          bid = Number(msg.bids?.[0]?.price || 0);
          ask = Number(msg.asks?.[0]?.price || 0);
        } else if (eventType === "price_change") {
          // price_change 包含增量，我们只在原有基础上更新 top of book (简化逻辑)
          // 实际上如果能收到 best_bid_ask 就不需要复杂的 price_change 处理
          return;
        }

        if (bid > 0 || ask > 0) {
          const mid = (bid > 0 && ask > 0) ? (bid + ask) / 2 : (bid || ask);
          const isNew = !this.prices.has(tokenId);
          this.prices.set(tokenId, {
            tokenId,
            bestBid: bid,
            bestAsk: ask,
            mid,
            lastUpdateAtMs: Date.now(),
          });
          if (isNew) {
            console.log(`[realtime-price] initially received price for ${tokenId}: Bid=${bid} Ask=${ask}`);
          }

          // 如果注册了回掉，则触发实时逻辑
          if (this.onPriceUpdate) {
            this.onPriceUpdate(this.prices.get(tokenId)!);
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  private resubscribeAll(): void {
    const ids = Array.from(this.watchedTokenIds);
    if (ids.length > 0) {
      this.subscribe(ids);
    }
  }

  private subscribe(tokenIds: string[]): void {
    if (!this.ws || !this.connected) return;

    // 根据官方文档 Market Channel 订阅格式:
    // { "assets_ids": [...], "type": "market", "custom_feature_enabled": true }
    // 注意：有些文档说用 "type": "subscribe", "topic": "market"
    // 我们尝试发送这种标准格式
    const payload = JSON.stringify({
      type: "subscribe",
      topic: "market",
      assets_ids: tokenIds,
      custom_feature_enabled: true
    });

    this.ws.send(payload);
    console.log(`[realtime-price] subscribed to market channel for ${tokenIds.length} tokens`);
  }
}
