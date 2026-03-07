import { ClobClient, Side } from "@polymarket/clob-client";
import { Wallet } from "ethers";

import type { Config } from "../config.js";

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

  static async create(config: Config): Promise<PolymarketTrader> {
    if (config.dryRun) {
      return new PolymarketTrader(config, null);
    }

    const signer = new Wallet(config.privateKey);
    const ClobCtor: any = ClobClient as any;
    const bootstrapClient: any = new ClobCtor(config.polyHost, config.chainId, signer);

    const creds: ApiCreds = config.apiKey && config.apiSecret && config.apiPassphrase
      ? {
          key: config.apiKey,
          secret: config.apiSecret,
          passphrase: config.apiPassphrase,
        }
      : await PolymarketTrader.deriveApiCreds(bootstrapClient);

    const funder = config.funderAddress || signer.address;
    const client = PolymarketTrader.buildClient(ClobCtor, config, signer, creds, funder);

    return new PolymarketTrader(config, client);
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
      return this.client.createAndPostOrder(order, options);
    }

    if (typeof this.client.createOrder === "function" && typeof this.client.postOrder === "function") {
      const signed = await this.client.createOrder(order, options);
      return this.client.postOrder(signed, options);
    }

    throw new Error("Unsupported clob client: no order posting method found");
  }

  private static async deriveApiCreds(client: any): Promise<ApiCreds> {
    if (typeof client.createOrDeriveApiKey === "function") {
      return client.createOrDeriveApiKey();
    }
    if (typeof client.createOrDeriveApiCreds === "function") {
      return client.createOrDeriveApiCreds();
    }
    if (typeof client.createApiKey === "function") {
      return client.createApiKey();
    }
    throw new Error("Unable to derive API creds from clob client");
  }

  private static buildClient(
    ClobCtor: any,
    config: Config,
    signer: Wallet,
    creds: ApiCreds,
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
