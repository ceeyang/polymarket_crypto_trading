import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Wallet } from "ethers";

import type { Config } from "../config.js";

const LOG_TO_STDOUT = !["0", "false", "off", "no"].includes(String(process.env.LOG_TO_STDOUT || "1").trim().toLowerCase());

interface ApiCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export class PolymarketTrader {
  private client: any;

  private constructor(private readonly config: Config, client: any | null) {
    this.client = client;
  }

  static async create(config: Config, options?: { forceClient?: boolean }): Promise<PolymarketTrader> {
    if (config.dryRun && !options?.forceClient) {
      return new PolymarketTrader(config, null);
    }

    if (!config.privateKey) {
      if (options?.forceClient) {
        throw new Error("PRIVATE_KEY is required to initialize Polymarket client");
      }
      return new PolymarketTrader(config, null);
    }

    const signer = new Wallet(config.privateKey);
    const ClobCtor: any = ClobClient as any;
    const funder = config.funderAddress || signer.address;
    const bootstrapClient: any = PolymarketTrader.buildClient(
      ClobCtor,
      config,
      signer,
      undefined,
      funder,
    );

    let client: any = null;
    if (config.apiKey && config.apiSecret && config.apiPassphrase) {
      const supplied: ApiCreds = {
        key: config.apiKey,
        secret: config.apiSecret,
        passphrase: config.apiPassphrase,
      };
      const suppliedClient = PolymarketTrader.buildClient(ClobCtor, config, signer, supplied, funder);
      const probe = await PolymarketTrader.probeApiCreds(suppliedClient);
      if (!PolymarketTrader.hasApiError(probe)) {
        client = suppliedClient;
      } else if (PolymarketTrader.isUnauthorized(probe)) {
        if (LOG_TO_STDOUT) {
          console.log("[polymarket] supplied POLY_API_* invalid for current signer/profile, fallback to derive");
        }
      } else {
        if (LOG_TO_STDOUT) {
          console.log("[polymarket] supplied POLY_API_* failed probe, fallback to derive", {
            error: PolymarketTrader.extractErrorMessage(probe),
          });
        }
      }
    }

    if (!client) {
      const creds: ApiCreds = await PolymarketTrader.deriveApiCreds(bootstrapClient);
      client = PolymarketTrader.buildClient(ClobCtor, config, signer, creds, funder);
    }

    return new PolymarketTrader(config, client);
  }

  async getBalanceAllowance(params?: { assetType?: string; tokenId?: string }): Promise<any> {
    if (!this.client) {
      throw new Error("Polymarket client unavailable");
    }
    const payload: Record<string, string> = {
      asset_type: params?.assetType || "COLLATERAL",
    };
    if (params?.tokenId) payload.token_id = params.tokenId;
    return this.client.getBalanceAllowance(payload);
  }

  async getOrder(orderId: string): Promise<any> {
    if (!this.client) {
      throw new Error("Polymarket client unavailable");
    }
    if (typeof this.client.getOrder !== "function") {
      throw new Error("Clob client does not support getOrder");
    }
    return this.client.getOrder(orderId);
  }

  async cancelOrder(orderId: string): Promise<any> {
    if (!this.client) {
      throw new Error("Polymarket client unavailable");
    }
    if (typeof this.client.cancelOrder !== "function") {
      throw new Error("Clob client does not support cancelOrder");
    }
    return this.client.cancelOrder({ orderID: orderId });
  }

  async getTrades(params?: Record<string, string>): Promise<any[]> {
    if (!this.client) {
      throw new Error("Polymarket client unavailable");
    }
    if (typeof this.client.getTrades !== "function") {
      throw new Error("Clob client does not support getTrades");
    }
    const rows = await this.client.getTrades(params ?? {});
    return Array.isArray(rows) ? rows : [];
  }

  async getAverageFillPrice(orderId: string, fallback: number): Promise<number> {
    let fallbackPrice = fallback;
    let tradeIds: string[] = [];
    try {
      const order = await this.getOrder(orderId);
      const orderPx = Number(order?.price);
      if (Number.isFinite(orderPx) && orderPx > 0) {
        fallbackPrice = orderPx;
      }
      const assoc = Array.isArray(order?.associate_trades) ? order.associate_trades : [];
      tradeIds = assoc.map((x: unknown) => String(x)).filter(Boolean);
    } catch {
      // use fallback
    }

    if (tradeIds.length === 0) return fallbackPrice;

    let totalPxSize = 0;
    let totalSize = 0;
    for (const id of tradeIds) {
      try {
        const rows = await this.getTrades({ id });
        const t = rows.find((x) => String(x?.id || "") === id) ?? rows[0];
        const px = Number(t?.price);
        const sz = Number(t?.size);
        if (!Number.isFinite(px) || !Number.isFinite(sz) || sz <= 0) continue;
        totalPxSize += px * sz;
        totalSize += sz;
      } catch {
        continue;
      }
    }

    if (totalSize > 0) return totalPxSize / totalSize;
    return fallbackPrice;
  }

  async placeBuyOrder(input: {
    tokenId: string;
    price: number;
    size: number;
    tickSize: number;
    negRisk: boolean;
  }): Promise<any> {
    if (this.config.dryRun || !this.client) {
      return {
        dryRun: true,
        request: input,
      };
    }

    const side = (Side as any).BUY ?? (Side as any).Buy ?? "BUY";

    const order = {
      tokenID: input.tokenId,
      tokenId: input.tokenId,
      price: input.price,
      size: input.size,
      side,
    };

    const options = {
      tickSize: String(input.tickSize),
      negRisk: input.negRisk,
    };

    if (typeof this.client.createAndPostOrder === "function") {
      return this.client.createAndPostOrder(order, options, (OrderType as any).GTC ?? "GTC");
    }

    if (typeof this.client.createOrder === "function" && typeof this.client.postOrder === "function") {
      const signed = await this.client.createOrder(order, options);
      return this.client.postOrder(signed, (OrderType as any).GTC ?? "GTC");
    }

    throw new Error("Unsupported clob client: no order posting method found");
  }

  private static async deriveApiCreds(client: any): Promise<ApiCreds> {
    // Prefer derive first to avoid noisy "Could not create api key" logs
    // from clients that call create() before derive().
    if (typeof client.deriveApiKey === "function") {
      const derived = await client.deriveApiKey();
      if (derived?.key) return derived;
    }
    if (typeof client.createApiKey === "function") {
      const created = await client.createApiKey();
      if (created?.key) return created;
    }
    if (typeof client.createOrDeriveApiKey === "function") {
      const creds = await client.createOrDeriveApiKey();
      if (creds?.key) return creds;
    }
    if (typeof client.createOrDeriveApiCreds === "function") {
      const creds = await client.createOrDeriveApiCreds();
      if (creds?.key) return creds;
    }
    throw new Error("Unable to derive API creds from clob client");
  }

  private static async probeApiCreds(client: any): Promise<any> {
    try {
      // Probe with a protected endpoint used by balance flow so invalid/mismatched
      // keys are caught before runtime usage.
      if (typeof client.getBalanceAllowance === "function") {
        return await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
      }
      if (typeof client.getApiKeys === "function") {
        return await client.getApiKeys();
      }
      return { ok: true };
    } catch (err) {
      return { error: PolymarketTrader.extractErrorMessage(err) };
    }
  }

  private static isUnauthorized(resp: any): boolean {
    if (!resp) return false;
    if (Number(resp?.status) === 401) return true;
    const msg = PolymarketTrader.extractErrorMessage(resp);
    return /unauthorized|invalid api key/i.test(msg);
  }

  private static hasApiError(resp: any): boolean {
    if (!resp) return false;
    return resp?.error !== undefined;
  }

  private static extractErrorMessage(err: any): string {
    if (!err) return "";

    const fromData = err?.response?.data;
    if (typeof fromData === "string") return fromData;
    if (typeof fromData?.error === "string") return fromData.error;

    if (typeof err?.error === "string") return err.error;
    if (typeof err?.error?.error === "string") return err.error.error;
    if (typeof err?.message === "string") return err.message;

    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  private static buildClient(
    ClobCtor: any,
    config: Config,
    signer: Wallet,
    creds: ApiCreds | undefined,
    funder: string,
  ): any {
    const constructors = [
      () => new ClobCtor(config.polyHost, config.chainId, signer, creds, config.signatureType, funder),
      () => new ClobCtor(config.polyHost, config.chainId, signer, creds, config.signatureType),
      () => new ClobCtor(config.polyHost, config.chainId, signer, creds),
    ];

    let lastErr: unknown = null;
    for (const build of constructors) {
      try {
        return build();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Failed to initialize ClobClient");
  }

  createWebsocketClient(): any {
    if (this.client && typeof this.client.createWebsocketClient === "function") {
      return this.client.createWebsocketClient();
    }
    // Fallback: 手动实现原生 WebSocket 连接 (Polymarket CLOB 协议)
    return new PolymarketWSManager(this.client, this.config);
  }
}

/**
 * 手动实现的 Polymarket WebSocket 管理器
 * 基于 Polymarket CLOB WS 官方协议
 */
class PolymarketWSManager {
  private ws: any = null;
  private openHandler: (() => void) | null = null;
  private messageHandler: ((data: any) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private errorHandler: ((err: any) => void) | null = null;
  
  private host: string;
  private isConnected = false;
  private authPending = false;
  private pendingSubscriptions: { type: string, ids?: string[] }[] = [];

  constructor(private clob: any, private config: Config) {
    // 根据 Host 转换 WS URL (https -> wss)
    const base = config.polyHost.replace(/^http/, "ws");
    this.host = base.endsWith("/ws") ? base : `${base.endsWith("/") ? base.slice(0, -1) : base}/ws`;
  }

  onOpen(fn: () => void) { this.openHandler = fn; }
  onMessage(fn: (data: any) => void) { this.messageHandler = fn; }
  onClose(fn: () => void) { this.closeHandler = fn; }
  onError(fn: (err: any) => void) { this.errorHandler = fn; }

  async connect() {
    try {
      this.ws = new (global as any).WebSocket(this.host);
      
      this.ws.onopen = async () => {
        // 如果有 API Credentials，进行 Auth
        if (this.clob?.creds?.key) {
           await this.authenticate();
        } else {
           this.onAuthenticated();
        }
      };

      this.ws.onmessage = (event: any) => {
        const data = JSON.parse(event.data);
        
        // 处理 Auth 响应
        if (data?.type === "auth") {
          if (data?.success) {
            this.onAuthenticated();
          } else {
            console.error("[ws] Auth Failed", data);
            if (this.errorHandler) this.errorHandler(new Error(`WS Auth Failed: ${data?.message}`));
          }
          return;
        }

        if (this.messageHandler) this.messageHandler(data);
      };

      this.ws.onclose = () => { 
        this.isConnected = false;
        if (this.closeHandler) this.closeHandler(); 
      };
      
      this.ws.onerror = (err: any) => { 
        if (this.errorHandler) this.errorHandler(err); 
      };
      
    } catch (err) {
      if (this.errorHandler) this.errorHandler(err);
    }
  }

  private async authenticate() {
    this.authPending = true;
    const ts = Math.floor(Date.now() / 1000);
    const creds = this.clob.creds;
    
    let sig = "";
    try {
       // 尝试调用 SDK 的签名工具（如果可用）或者简单的 HMAC 模拟
       // 签名明文: timestamp + "GET" + "/ws"
       const { buildPolyHmacSignature } = await import("@polymarket/clob-client/dist/signing/hmac.js");
       sig = buildPolyHmacSignature(creds.secret, ts, "GET", "/ws");
    } catch (e) {
       console.error("[ws] Signature Logic Failure", e);
    }

    if (sig) {
      this.send({
        type: "auth",
        api_key: creds.key,
        passphrase: creds.passphrase,
        timestamp: String(ts),
        signature: sig
      });
    }
  }

  private onAuthenticated() {
    this.authPending = false;
    this.isConnected = true;
    if (this.openHandler) this.openHandler();
    
    // 执行累积的订阅
    for (const sub of this.pendingSubscriptions) {
       this.subscribe(sub.type, sub.ids);
    }
    this.pendingSubscriptions = [];
  }

  subscribe(channel: string, marketIds?: string[]) {
    if (this.authPending || !this.isConnected || !this.ws || this.ws.readyState !== 1) {
       this.pendingSubscriptions.push({ type: channel, ids: marketIds });
       return;
    }

    const msg: any = {
      type: "subscribe",
      channels: [channel]
    };
    if (marketIds && marketIds.length > 0) {
      msg.market_ids = marketIds;
    }
    this.send(msg);
  }

  private send(msg: any) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}

