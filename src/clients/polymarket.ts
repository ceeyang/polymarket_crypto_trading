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

  /**
   * 获取特定 Token 的最新盘口中间价/参考价
   */
  async getMidPrice(tokenId: string): Promise<{ bid: number, ask: number, mid: number }> {
    if (!this.client) throw new Error("Polymarket client unavailable");
    try {
      if (typeof this.client.getOrderBook === "function") {
        const ob = await this.client.getOrderBook(tokenId);
        const bid = Number(ob?.bids?.[0]?.price || 0);
        const ask = Number(ob?.asks?.[0]?.price || 0);
        return { 
          bid, 
          ask, 
          mid: (bid > 0 && ask > 0) ? (bid + ask) / 2 : (bid || ask || 0) 
        };
      }
    } catch {
      // fallback
    }
    return { bid: 0, ask: 0, mid: 0 };
  }

  /**
   * 获取底层 ClobClient 实例，用于 WebSocket 等高级操作
   */
  getClobClient(): any {
    return this.client;
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
}
