import axios from "axios";
import { Wallet, ethers } from "ethers";
import {
  RelayClient,
  RelayerTransactionState,
  RelayerTxType,
  type RelayerTransaction,
  type Transaction,
} from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { createWalletClient, encodeFunctionData, http, isAddress, type Hex, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

import type { Config } from "../config.js";

const LOG_TO_STDOUT = !["0", "false", "off", "no"].includes(String(process.env.LOG_TO_STDOUT || "1").trim().toLowerCase());
const CLAIM_WAIT_TIMEOUT_MS = Math.max(60_000, Math.floor(Number(process.env.CLAIM_WAIT_TIMEOUT_MS || 20 * 60_000)));
const CLAIM_WAIT_POLL_MS = Math.max(1_000, Math.floor(Number(process.env.CLAIM_WAIT_POLL_MS || 3_000)));
const RELAYER_SUCCESS_STATES = new Set<string>([
  RelayerTransactionState.STATE_MINED,
  RelayerTransactionState.STATE_CONFIRMED,
]);
const RELAYER_FAILED_STATES = new Set<string>([
  RelayerTransactionState.STATE_FAILED,
  RelayerTransactionState.STATE_INVALID,
]);

const CTF_REDEEM_ABI = [
  {
    type: "function",
    name: "redeemPositions",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;

export interface ClaimRunOptions {
  conditionIds?: string[];
  logPrefix?: string;
  quietNoop?: boolean;
  maxConcurrency?: number;
  forceLive?: boolean;
  logger?: (msg: string, obj?: unknown, tag?: string, level?: string) => void;
}

export interface ClaimRunSummary {
  user: string;
  redeemablePositions: number;
  conditions: number;
  success: number;
  failed: number;
  dryRun: boolean;
  reason?: string;
}

function log(prefix: string, msg: string, obj?: unknown): void {
  if (!LOG_TO_STDOUT) return;
  if (obj == null) {
    console.log(`${prefix} ${msg}`);
  } else {
    console.log(`${prefix} ${msg}`, obj);
  }
}

function normalizeConditionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) return null;
  return v;
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function extractClaimableUsd(position: any): number {
  return asNumber(position?.currentValue);
}

function normalizePrivateKey(raw: string): Hex {
  const v = raw.trim();
  const withPrefix = v.startsWith("0x") ? v : `0x${v}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error("Invalid PRIVATE_KEY format; expected 32-byte hex key");
  }
  return withPrefix as Hex;
}

function asAddress(name: string, raw: string): Hex {
  const v = raw.trim();
  if (!isAddress(v)) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return v as Hex;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientNetworkError(err: unknown): boolean {
  const message = getErrorMessage(err).toLowerCase();
  return [
    "econnreset",
    "etimedout",
    "timeout",
    "socket hang up",
    "network error",
    "temporarily unavailable",
    "502",
    "503",
    "504",
  ].some((token) => message.includes(token));
}

function pickLatestTransaction(txns: RelayerTransaction[]): RelayerTransaction | null {
  if (!Array.isArray(txns) || txns.length === 0) return null;
  const sorted = [...txns].sort((a, b) => {
    const timeA = Date.parse(String(a?.updatedAt ?? a?.createdAt ?? 0));
    const timeB = Date.parse(String(b?.updatedAt ?? b?.createdAt ?? 0));
    return timeB - timeA;
  });
  return sorted[0] ?? null;
}

async function waitForTransactionState(
  client: RelayClient,
  transactionId: string,
  conditionId: string,
  logPrefix: string,
  timeoutMs = CLAIM_WAIT_TIMEOUT_MS,
): Promise<RelayerTransaction> {
  const startedAt = Date.now();
  let lastLoggedState = "";

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const txns = await client.getTransaction(transactionId);
      const txn = pickLatestTransaction(txns);
      if (txn) {
        const state = String(txn.state || "");
        if (state && state !== lastLoggedState) {
          lastLoggedState = state;
          log(logPrefix, "relayer state", {
            conditionId,
            transactionID: transactionId,
            state,
            txHash: txn.transactionHash,
          });
        }
        if (RELAYER_SUCCESS_STATES.has(state)) {
          return txn;
        }
        if (RELAYER_FAILED_STATES.has(state)) {
          throw new Error(`Relayer transaction failed with state=${state} txHash=${txn.transactionHash || "-"}`);
        }
      }
    } catch (err) {
      if (!isTransientNetworkError(err)) {
        throw err;
      }
      log(logPrefix, "relayer poll transient error", {
        conditionId,
        transactionID: transactionId,
        error: getErrorMessage(err),
      });
    }

    await sleep(CLAIM_WAIT_POLL_MS);
  }

  throw new Error(`Relayer transaction timed out after ${timeoutMs}ms (transactionID=${transactionId})`);
}

async function findExistingRedeemTransaction(
  client: RelayClient,
  metadata: string,
): Promise<RelayerTransaction | null> {
  const txns = await client.getTransactions();
  const related = (Array.isArray(txns) ? txns : []).filter((txn) => String(txn?.metadata || "") === metadata);
  return pickLatestTransaction(related);
}

async function pickWorkingRpcUrl(
  rpcUrls: string[],
  chainId: number,
  logPrefix: string,
  logger?: (msg: string, obj?: unknown) => void,
): Promise<string> {
  const tried: Array<{ url: string; error: string }> = [];

  for (const url of rpcUrls) {
    const provider = new ethers.providers.StaticJsonRpcProvider(
      { url, timeout: 15000 },
      { chainId, name: chainId === 137 ? "matic" : "unknown" },
    );
    try {
      await provider.getBlockNumber();
      if (logger) {
        logger("rpc connected", { rpcUrl: url });
      } else {
        log(logPrefix, "rpc connected", { rpcUrl: url });
      }
      return url;
    } catch (err) {
      tried.push({ url, error: getErrorMessage(err) });
      if (logger) {
        logger("rpc failed", { rpcUrl: url, error: tried[tried.length - 1].error });
      } else {
        log(logPrefix, "rpc failed", { rpcUrl: url, error: tried[tried.length - 1].error });
      }
    }
  }

  const detail = tried.map((x) => `${x.url} -> ${x.error}`).join(" | ");
  throw new Error(`No available RPC endpoint. tried=${detail}`);
}

function createRelayClient(cfg: Config, privateKey: Hex, rpcUrl: string): { client: RelayClient; txType: RelayerTxType } {
  const key = cfg.builderApiKey?.trim() || "";
  const secret = cfg.builderSecret?.trim() || "";
  const passphrase = cfg.builderPassphrase?.trim() || "";
  if (!key || !secret || !passphrase) {
    throw new Error("Missing builder secrets. Set POLY_BUILDER_API_KEY/POLY_BUILDER_SECRET/POLY_BUILDER_PASSPHRASE in .env");
  }

  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({
    account,
    chain: cfg.chainId === polygon.id ? polygon : undefined,
    transport: http(rpcUrl, { timeout: 15_000 }),
  });

  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key,
      secret,
      passphrase,
    },
  });

  const txType = cfg.relayerTxType === "SAFE" ? RelayerTxType.SAFE : RelayerTxType.PROXY;
  const client = new RelayClient(cfg.relayerHost, cfg.chainId, wallet, builderConfig, txType);
  return { client, txType };
}

function createCtfRedeemTransaction(cfg: Config, conditionId: Hex): Transaction {
  const data = encodeFunctionData({
    abi: CTF_REDEEM_ABI,
    functionName: "redeemPositions",
    args: [
      asAddress("usdcAddress", cfg.usdcAddress),
      zeroHash,
      conditionId,
      [1n, 2n],
    ],
  });

  return {
    to: asAddress("ctfAddress", cfg.ctfAddress),
    data,
    value: "0",
  };
}

async function executeBatchRedeem(
  client: RelayClient,
  txType: RelayerTxType,
  txs: Transaction[],
  conditionIds: string[],
  logPrefix: string,
  logger: (msg: string, obj?: unknown, level?: string) => void,
): Promise<void> {
  const metadata = `ctf batch redeem ${conditionIds.length} ids`;
  logger("preparing batch redeem transaction", { count: conditionIds.length, txType });

  let response;
  try {
    logger("asynchronously requesting relayer batch execute...", { conditionIds });
    response = await client.execute(txs, metadata);
  } catch (err) {
    const message = getErrorMessage(err);
    if (txType === RelayerTxType.SAFE && /safe not deployed/i.test(message)) {
      logger("safe not deployed; deploying now");
      const deployResp = await client.deploy();
      const deployResult = await deployResp.wait();
      if (!deployResult) {
        throw new Error("Safe deploy failed or timed out");
      }
      logger("safe deployed", {
        transactionID: deployResult.transactionID,
        txHash: deployResult.transactionHash,
        safe: deployResult.proxyAddress,
      });
      logger("resending original batch redeem transaction");
      response = await client.execute(txs, metadata);
    } else {
      throw err;
    }
  }

  logger("submitted to relayer", {
    transactionID: response.transactionID,
    state: response.state,
    txHash: response.transactionHash,
    batchSize: conditionIds.length,
  });

  try {
    const finalTx = await response.wait();
    if (finalTx) {
      logger("confirmed", {
        txHash: finalTx.transactionHash,
        state: finalTx.state,
        batchSize: conditionIds.length,
      }, "success");
    }
  } catch (err) {
    logger("confirmation check failed", {
      error: getErrorMessage(err),
    }, "warn");
  }

  await waitForTransactionState(client, response.transactionID, "batch", logPrefix);
}

export async function claimRedeemablePositions(cfg: Config, options?: ClaimRunOptions): Promise<ClaimRunSummary> {
  const logPrefix = options?.logPrefix ?? "[claim]";
  const quietNoop = Boolean(options?.quietNoop);
  const maxConcurrency = Math.max(1, Math.floor(Number(options?.maxConcurrency ?? 1)));
  const effectiveDryRun = cfg.dryRun && !Boolean(options?.forceLive);

  const rawPrivateKey = cfg.privateKey || process.env.PRIVATE_KEY;
  if (!rawPrivateKey) {
    if (effectiveDryRun) {
      return { user: "dummy", redeemablePositions: 0, conditions: 0, success: 0, failed: 0, dryRun: true, reason: "dry-run" };
    }
    throw new Error("PRIVATE_KEY missing in .env");
  }

  const privateKey = normalizePrivateKey(rawPrivateKey);
  const signer = new Wallet(privateKey);
  const user = cfg.funderAddress && cfg.funderAddress.trim() ? cfg.funderAddress.trim() : signer.address;

  const claimLog = (msg: string, obj?: unknown, level = "info") => {
    if (options?.logger) {
      options.logger(msg, obj, "auto-claim", level);
    } else {
      log(logPrefix, msg, obj);
    }
  };

  claimLog("fetching positions", { user });
  const { data } = await axios.get(`${cfg.dataApiHost}/positions`, {
    params: { user, size: 100, redeemable: true, sortBy: 'CURRENT' },
    timeout: 20000,
  });

  const positions = Array.isArray(data) ? data : [];
  claimLog("raw positions found", { count: positions.length });

  const redeemable = positions.filter((p: any) => {
    const isRedeemable = Boolean(p?.redeemable);
    const size = Number(p?.size ?? 0);
    const usd = extractClaimableUsd(p);
    // 只要是可赎回且持仓大于 0 即可，不需要 curPrice > 0 (已结算盘口价格常为 0)
    if (isRedeemable && size > 0) return true;

    if (isRedeemable && size <= 0) {
      claimLog("position skipped", {
        conditionId: p?.conditionId,
        size,
        usd,
        reason: "size <= 0"
      }, "warn");
    }
    return false;
  });

  claimLog("filter results", {
    rawCount: positions.length,
    redeemableCount: redeemable.length,
  });

  const whitelist = new Set((options?.conditionIds ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean));
  const actionablePositions = redeemable.filter((p: any) => {
    const cid = normalizeConditionId(p?.conditionId);
    if (!cid) return false;
    if (whitelist.size && !whitelist.has(cid.toLowerCase())) return false;
    const usd = extractClaimableUsd(p);
    if (usd <= 0) {
      return false;
    }
    return true;
  });

  const conditionIds = Array.from(new Set(
    actionablePositions.map((p: any) => normalizeConditionId(p?.conditionId)!)
  ));

  const totalConditions = conditionIds.length;
  claimLog("selection summary", {
    raw: positions.length,
    redeemable: redeemable.length,
    actionable: totalConditions,
    whitelistActive: whitelist.size > 0
  });

  if (totalConditions === 0) {
    return {
      user,
      redeemablePositions: redeemable.length,
      conditions: 0,
      success: 0,
      failed: 0,
      dryRun: effectiveDryRun,
      reason: "no actionable winning positions",
    };
  }

  if (cfg.funderAddress && cfg.funderAddress.toLowerCase() !== signer.address.toLowerCase()) {
    claimLog("info: FUNDER_ADDRESS differs from signer address; relayer flow will target signer's proxy/safe path", {
      signer: signer.address,
      funder: cfg.funderAddress,
    });
  }

  claimLog("targets", {
    user,
    conditions: totalConditions,
    dryRun: effectiveDryRun,
    forceLive: Boolean(options?.forceLive),
    relayerHost: cfg.relayerHost,
    relayerTxType: cfg.relayerTxType,
    waitTimeoutMs: CLAIM_WAIT_TIMEOUT_MS,
    waitPollMs: CLAIM_WAIT_POLL_MS,
  });

  if (effectiveDryRun) {
    claimLog("dry-run conditionIds", conditionIds);
    return {
      user,
      redeemablePositions: redeemable.length,
      conditions: totalConditions,
      success: 0,
      failed: 0,
      dryRun: true,
      reason: "dry-run",
    };
  }

  const rpcUrl = await pickWorkingRpcUrl(cfg.rpcUrls, cfg.chainId, logPrefix, (m, o) => claimLog(m, o));
  const { client, txType } = createRelayClient(cfg, privateKey, rpcUrl);

  let success = 0;
  let failed = 0;

  const BATCH_SIZE = 10;
  for (let i = 0; i < conditionIds.length; i += BATCH_SIZE) {
    const batchIds = conditionIds.slice(i, i + BATCH_SIZE);
    try {
      const txs = batchIds.map((cid) => createCtfRedeemTransaction(cfg, cid as Hex));
      await executeBatchRedeem(client, txType, txs, batchIds, logPrefix, (m, o, l) => claimLog(m, o, l));
      success += batchIds.length;
    } catch (err) {
      failed += batchIds.length;
      claimLog("batch redeem failed", {
        ids: batchIds,
        error: getErrorMessage(err),
      }, "error");
    }
  }

  claimLog("finish", {
    user,
    total: totalConditions,
    success,
    failed,
    dryRun: false,
  });

  return {
    user,
    redeemablePositions: redeemable.length,
    conditions: totalConditions,
    success,
    failed,
    dryRun: false,
  };
}
