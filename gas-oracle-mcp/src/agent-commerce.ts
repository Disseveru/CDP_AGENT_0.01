/**
 * High-frequency agent-to-agent commerce helpers.
 *
 * These SKUs sit on top of live gas/balance/tx reads and answer the questions
 * buyer agents actually loop on:
 *  - Can I afford N paid tool calls at this USDC price?
 *  - Did the seller's settlement tx land?
 *  - Which chain is cheapest for the next write?
 */
import { getTxStatus, type GetTxStatusResult } from "./gas.js";
import { estimateTxCost, getGasOracleBatch, type GasOracleResult } from "./gas-oracle.js";

const USDC_PRICE_RE = /^\$?(0|[1-9]\d*)(\.\d{1,6})?$/;

export function parseUsdAmount(raw: unknown, label: string): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (USDC_PRICE_RE.test(trimmed.replace(/^\$/, ""))) {
      return Number(trimmed.replace(/^\$/, ""));
    }
    const n = Number(trimmed.replace(/^\$/, ""));
    if (Number.isFinite(n) && n >= 0) return n;
  }
  throw new Error(`${label} must be a non-negative USD amount (e.g. 1.25 or $0.005)`);
}

export interface PlanAgentSpendInput {
  balanceUsd: unknown;
  pricePerCallUsd: unknown;
  maxCalls?: unknown;
  reserveUsd?: unknown;
}

export interface PlanAgentSpendResult {
  balanceUsd: number;
  pricePerCallUsd: number;
  reserveUsd: number;
  spendableUsd: number;
  maxAffordableCalls: number;
  plannedCalls: number;
  plannedSpendUsd: number;
  remainingUsd: number;
  canAffordAtLeastOne: boolean;
  recommendation: string;
  plannedAt: string;
}

export function planAgentSpend(input: PlanAgentSpendInput): PlanAgentSpendResult {
  const balanceUsd = parseUsdAmount(input.balanceUsd, "balanceUsd");
  const pricePerCallUsd = parseUsdAmount(input.pricePerCallUsd, "pricePerCallUsd");
  const reserveUsd = input.reserveUsd === undefined ? 0 : parseUsdAmount(input.reserveUsd, "reserveUsd");

  if (pricePerCallUsd <= 0) {
    throw new Error("pricePerCallUsd must be greater than 0");
  }

  let maxCalls = 10_000;
  if (input.maxCalls !== undefined) {
    const raw = typeof input.maxCalls === "number" ? input.maxCalls : Number(input.maxCalls);
    if (!Number.isInteger(raw) || raw < 1 || raw > 10_000) {
      throw new Error("maxCalls must be an integer between 1 and 10000");
    }
    maxCalls = raw;
  }

  const spendableUsd = Math.max(0, Number((balanceUsd - reserveUsd).toFixed(6)));
  const maxAffordableCalls = Math.floor(spendableUsd / pricePerCallUsd);
  const plannedCalls = Math.min(maxAffordableCalls, maxCalls);
  const plannedSpendUsd = Number((plannedCalls * pricePerCallUsd).toFixed(6));
  const remainingUsd = Number((balanceUsd - plannedSpendUsd).toFixed(6));
  const canAffordAtLeastOne = plannedCalls >= 1;

  let recommendation: string;
  if (!canAffordAtLeastOne) {
    recommendation =
      spendableUsd <= 0
        ? "Do not buy. Balance is at or below the reserve floor."
        : `Cannot afford one call at $${pricePerCallUsd}. Need at least $${(pricePerCallUsd + reserveUsd).toFixed(6)}.`;
  } else if (plannedCalls < maxCalls) {
    recommendation = `Buy ${plannedCalls} call(s), then refill. Budget exhausted before maxCalls.`;
  } else {
    recommendation = `Safe to buy ${plannedCalls} call(s) and keep $${remainingUsd.toFixed(6)} after spend.`;
  }

  return {
    balanceUsd,
    pricePerCallUsd,
    reserveUsd,
    spendableUsd,
    maxAffordableCalls,
    plannedCalls,
    plannedSpendUsd,
    remainingUsd,
    canAffordAtLeastOne,
    recommendation,
    plannedAt: new Date().toISOString(),
  };
}

export interface VerifySettlementInput {
  hash: string;
  network?: string;
  expectedTo?: string;
}

export interface VerifySettlementResult {
  verified: boolean;
  reason: string;
  tx: GetTxStatusResult;
  expectedTo: string | null;
  toMatched: boolean | null;
}

export async function verifySettlementTx(input: VerifySettlementInput): Promise<VerifySettlementResult> {
  const tx = await getTxStatus({ hash: input.hash, network: input.network });
  const expectedTo = input.expectedTo ? String(input.expectedTo).trim() : null;

  let toMatched: boolean | null = null;
  if (expectedTo && tx.to) {
    toMatched = tx.to.toLowerCase() === expectedTo.toLowerCase();
  }

  if (tx.status === "not_found") {
    return { verified: false, reason: "Transaction not found on the requested network.", tx, expectedTo, toMatched };
  }
  if (tx.status === "pending") {
    return { verified: false, reason: "Transaction is still pending.", tx, expectedTo, toMatched };
  }
  if (tx.status === "reverted") {
    return { verified: false, reason: "Transaction reverted on-chain.", tx, expectedTo, toMatched };
  }
  if (toMatched === false) {
    return {
      verified: false,
      reason: `Recipient mismatch. on-chain to=${tx.to} expected=${expectedTo}`,
      tx,
      expectedTo,
      toMatched,
    };
  }

  return {
    verified: true,
    reason: "Settlement transaction succeeded on-chain.",
    tx,
    expectedTo,
    toMatched,
  };
}

export interface CheapestChainInput {
  gasLimit?: unknown;
  chains?: unknown;
}

export interface CheapestChainResult {
  gasLimit: string;
  cheapest: {
    chain: string;
    costUsd: string;
    costNative: string;
    nativeSymbol: string;
    maxFeeGwei: string;
  } | null;
  ranked: Array<{
    chain: string;
    costUsd: string;
    costNative: string;
    nativeSymbol: string;
    maxFeeGwei: string;
    error?: string;
  }>;
  snapshot: GasOracleResult[];
  comparedAt: string;
}

export async function cheapestChainForTx(input: CheapestChainInput = {}): Promise<CheapestChainResult> {
  const gasLimit =
    input.gasLimit === undefined || input.gasLimit === null ? 65_000 : input.gasLimit;

  const chains =
    input.chains === undefined || input.chains === null
      ? ["base", "ethereum", "arbitrum", "optimism", "polygon"]
      : input.chains;

  const batch = await getGasOracleBatch(chains);
  const ranked: CheapestChainResult["ranked"] = [];

  for (const chain of Array.isArray(chains) ? chains.map(String) : ["base"]) {
    if (batch.errors[chain]) {
      ranked.push({
        chain,
        costUsd: "n/a",
        costNative: "n/a",
        nativeSymbol: "?",
        maxFeeGwei: "n/a",
        error: batch.errors[chain],
      });
      continue;
    }
    try {
      const estimate = await estimateTxCost({ chain, gasLimit });
      ranked.push({
        chain: estimate.chain,
        costUsd: estimate.costUsd,
        costNative: estimate.costNative,
        nativeSymbol: estimate.nativeSymbol,
        maxFeeGwei: estimate.maxFeeGwei,
      });
    } catch (error) {
      ranked.push({
        chain,
        costUsd: "n/a",
        costNative: "n/a",
        nativeSymbol: "?",
        maxFeeGwei: "n/a",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const priced = ranked
    .filter((row) => !row.error && Number.isFinite(Number(row.costUsd)))
    .sort((a, b) => Number(a.costUsd) - Number(b.costUsd));

  return {
    gasLimit: String(typeof gasLimit === "number" ? Math.floor(gasLimit) : gasLimit),
    cheapest: priced[0]
      ? {
          chain: priced[0].chain,
          costUsd: priced[0].costUsd,
          costNative: priced[0].costNative,
          nativeSymbol: priced[0].nativeSymbol,
          maxFeeGwei: priced[0].maxFeeGwei,
        }
      : null,
    ranked,
    snapshot: batch.results,
    comparedAt: new Date().toISOString(),
  };
}
