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
  const candidates = [
    position?.claimableValue,
    position?.claimable_value,
    position?.claimableAmount,
    position?.claimable_amount,
    position?.redeemableValue,
    position?.redeemable_value,
    position?.payoutValue,
    position?.payout_value,
    position?.payout,
    position?.currentValue,
    position?.current_value,
    position?.curValue,
    position?.value,
    position?.usdValue,
    position?.usdcValue,
    position?.finalValue,
    position?.final_value,
    position?.claimableAmount,
    position?.redeemable_usd,
    position?.total_payout_usd,
  ]
    .map((x) => asNumber(x))
    .filter((x) => x >= 0);

  if (!candidates.length) return 0;
  return Math.max(...candidates);
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

async function pickWorkingRpcUrl(rpcUrls: string[], chainId: number, logPrefix: string): Promise<string> {
  const tried: Array<{ url: string; error: string }> = [];

  for (const url of rpcUrls) {
    const provider = new ethers.providers.StaticJsonRpcProvider(
      { url, timeout: 15000 },
      { chainId, name: chainId === 137 ? "matic" : "unknown" },
    );
    try {
      await provider.getBlockNumber();
      log(logPrefix, "rpc connected", { rpcUrl: url });
      return url;
    } catch (err) {
      tried.push({ url, error: getErrorMessage(err) });
      log(logPrefix, "rpc failed", { rpcUrl: url, error: tried[tried.length - 1].error });
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

async function executeRedeem(
  client: RelayClient,
  txType: RelayerTxType,
  tx: Transaction,
  conditionId: string,
  logPrefix: string,
): Promise<void> {
  const metadata = `ctf redeem ${conditionId}`;
  try {
    const existing = await findExistingRedeemTransaction(client, metadata);
    if (existing) {
      const state = String(existing.state || "");
      if (RELAYER_SUCCESS_STATES.has(state)) {
        log(logPrefix, "reuse existing redeemed tx", {
          conditionId,
          transactionID: existing.transactionID,
          state,
          txHash: existing.transactionHash,
        });
        return;
      }
      if (!RELAYER_FAILED_STATES.has(state)) {
        log(logPrefix, "reuse existing pending tx", {
          conditionId,
          transactionID: existing.transactionID,
          state,
          txHash: existing.transactionHash,
        });
        await waitForTransactionState(client, existing.transactionID, conditionId, logPrefix);
        return;
      }
    }
  } catch (err) {
    log(logPrefix, "existing transaction lookup failed", {
      conditionId,
      error: getErrorMessage(err),
    });
  }

  let response;
  try {
    response = await client.execute([tx], metadata);
  } catch (err) {
    const message = getErrorMessage(err);
    if (txType === RelayerTxType.SAFE && /safe not deployed/i.test(message)) {
      log(logPrefix, "safe not deployed; deploying now");
      const deployResp = await client.deploy();
      const deployResult = await deployResp.wait();
      if (!deployResult) {
        throw new Error("Safe deploy failed or timed out");
      }
      log(logPrefix, "safe deployed", {
        transactionID: deployResult.transactionID,
        txHash: deployResult.transactionHash,
        safe: deployResult.proxyAddress,
      });
      response = await client.execute([tx], metadata);
    } else {
      throw err;
    }
  }

  log(logPrefix, "submitted", {
    conditionId,
    transactionID: response.transactionID,
    state: response.state,
    txHash: response.transactionHash,
  });

  const result = await waitForTransactionState(client, response.transactionID, conditionId, logPrefix);

  log(logPrefix, "redeemed", {
    conditionId,
    transactionID: result.transactionID,
    txHash: result.transactionHash,
    state: result.state,
  });
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
    params: { user, size: 1000 },
    timeout: 20000,
  });

  const positions = Array.isArray(data) ? data : [];
  claimLog("raw positions found", { count: positions.length });

  const redeemable = positions.filter((p: any) => {
    const isRedeemable = Boolean(p?.redeemable);
    const size = Number(p?.size ?? p?.amount ?? 0);
    const usd = extractClaimableUsd(p);
    claimLog("position", p);

    if (isRedeemable && size > 0 && usd > 0) return true;

    // 增加详细诊断日志，仅在有 redeemable 标记但过滤失败时
    if (isRedeemable && (size <= 0 || usd <= 0)) {
      claimLog("position skipped", {
        conditionId: p?.conditionId || p?.condition_id,
        size,
        usd,
        reason: size <= 0 ? "size <= 0" : "usd <= 0"
      }, "warn");
    }
    return false;
  });

  const whitelist = new Set((options?.conditionIds ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean));
  const conditionIds = Array.from(new Set(
    redeemable
      .map((p: any) => normalizeConditionId(p?.conditionId ?? p?.condition_id))
      .filter((x: string | null): x is string => Boolean(x))
      .filter((x: string) => (whitelist.size ? whitelist.has(x.toLowerCase()) : true)),
  ));
  const totalConditions = conditionIds.length;

  if (totalConditions === 0) {
    if (!quietNoop) {
      claimLog("no redeemable condition ids found", { user, redeemablePositions: redeemable.length });
    }
    return {
      user,
      redeemablePositions: redeemable.length,
      conditions: 0,
      success: 0,
      failed: 0,
      dryRun: effectiveDryRun,
      reason: "no redeemable condition ids",
    };
  }

  if (cfg.funderAddress && cfg.funderAddress.toLowerCase() !== signer.address.toLowerCase()) {
    log(logPrefix, "info: FUNDER_ADDRESS differs from signer address; relayer flow will target signer's proxy/safe path", {
      signer: signer.address,
      funder: cfg.funderAddress,
    });
  }

  log(logPrefix, "targets", {
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
    log(logPrefix, "dry-run conditionIds", conditionIds);
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

  const rpcUrl = await pickWorkingRpcUrl(cfg.rpcUrls, cfg.chainId, logPrefix);
  const { client, txType } = createRelayClient(cfg, privateKey, rpcUrl);
  const effectiveConcurrency = txType === RelayerTxType.SAFE ? 1 : maxConcurrency;

  if (effectiveConcurrency !== maxConcurrency) {
    log(logPrefix, "override concurrency for SAFE relayer", {
      requested: maxConcurrency,
      effective: effectiveConcurrency,
      reason: "safe transactions must use sequential nonces",
    });
  }

  let success = 0;
  let failed = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const conditionId = conditionIds.shift();
      if (!conditionId) return;
      try {
        const tx = createCtfRedeemTransaction(cfg, conditionId as Hex);
        await executeRedeem(client, txType, tx, conditionId, logPrefix);
        success += 1;
      } catch (err) {
        failed += 1;
        log(logPrefix, "failed", {
          conditionId,
          error: getErrorMessage(err),
        });
      }
    }
  };

  if (effectiveConcurrency <= 1 || conditionIds.length <= 1) {
    await worker();
  } else {
    const workers = Math.min(effectiveConcurrency, conditionIds.length);
    await Promise.all(Array.from({ length: workers }, async () => worker()));
  }

  const summary: ClaimRunSummary = {
    user,
    redeemablePositions: redeemable.length,
    conditions: totalConditions,
    success,
    failed,
    dryRun: effectiveDryRun,
  };
  log(logPrefix, "summary", summary);
  return summary;
}
