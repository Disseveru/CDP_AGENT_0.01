/**
 * Combine gas oracle + optional x402 probe into a single settlement quote
 * agents can use before paying for a Bazaar resource or broadcasting a tx.
 */
import { estimateTxCost, getGasOracle, type SupportedChainId } from "./gas-oracle.js";
import { probeResource, type ProbeResourceResult } from "./probe-resource.js";

const X402_NETWORK_TO_CHAIN: Record<string, SupportedChainId> = {
  "eip155:8453": "base",
  "eip155:84532": "base-sepolia",
  "eip155:1": "ethereum",
  "eip155:42161": "arbitrum",
  "eip155:10": "optimism",
  "eip155:137": "polygon",
  base: "base",
  "base-sepolia": "base-sepolia",
  ethereum: "ethereum",
  arbitrum: "arbitrum",
  optimism: "optimism",
  polygon: "polygon",
};

export interface QuoteSettlementInput {
  /** Chain for gas quote. Default: base */
  chain?: string;
  /** Optional gas limit for custom cost estimate. */
  gasLimit?: number | string;
  /** Optional public resource URL to probe for x402 requirements. */
  resourceUrl?: string;
  /** HTTP method for resource probe. */
  method?: "GET" | "POST" | "HEAD";
  /** Optional x402 amount in USDC (human units, e.g. 0.01) already known by the agent. */
  knownPriceUsdc?: number | string;
}

export interface QuoteSettlementResult {
  timestamp: string;
  chain: SupportedChainId;
  gas: {
    gasPriceGwei: string;
    maxFeeGwei: string;
    maxPriorityFeeGwei: string;
    nativeUsdPrice: number;
    nativeSymbol: string;
    transferCostUsd: string;
    customCostUsd: string | null;
    customGasLimit: string | null;
  };
  x402: {
    probed: boolean;
    paymentRequired: boolean;
    freeAccess: boolean;
    dead: boolean;
    lowestPriceUsdc: string | null;
    accepts: ProbeResourceResult["accepts"];
    latencyMs: number | null;
    status: number | null;
    error?: string;
  };
  /** Rough total USD if agent pays x402 + executes a standard transfer-sized tx. */
  totalUsdEstimate: string;
  recommendation: string;
}

function parseUsdcAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  // Protocol often uses atomic units (6 decimals for USDC)
  if (n >= 1000 && Number.isInteger(n)) {
    return n / 1_000_000;
  }
  return n;
}

function lowestAcceptUsdc(accepts: ProbeResourceResult["accepts"]): string | null {
  let best: number | null = null;
  for (const a of accepts) {
    const parsed = parseUsdcAmount(a.amount);
    if (parsed === null) continue;
    if (best === null || parsed < best) best = parsed;
  }
  return best === null ? null : best.toFixed(6);
}

function resolveChainFromProbe(
  preferred: string | undefined,
  probe: ProbeResourceResult | null,
): string {
  if (preferred) return preferred;
  const net = probe?.accepts?.[0]?.network;
  if (net && X402_NETWORK_TO_CHAIN[net]) {
    return X402_NETWORK_TO_CHAIN[net];
  }
  return "base";
}

/** Quote gas + optional x402 payment for an agent settlement decision. */
export async function quoteSettlement(
  input: QuoteSettlementInput = {},
): Promise<QuoteSettlementResult> {
  let probe: ProbeResourceResult | null = null;
  if (input.resourceUrl) {
    probe = await probeResource({
      url: input.resourceUrl,
      method: input.method || "GET",
    });
  }

  const chainId = resolveChainFromProbe(input.chain, probe);
  const oracle = await getGasOracle(chainId);

  let customCostUsd: string | null = null;
  let customGasLimit: string | null = null;
  if (input.gasLimit !== undefined && input.gasLimit !== null && input.gasLimit !== "") {
    const custom = await estimateTxCost({ chain: chainId, gasLimit: input.gasLimit });
    customCostUsd = custom.costUsd;
    customGasLimit = custom.gasLimit;
  }

  let lowestPriceUsdc: string | null = null;
  if (input.knownPriceUsdc !== undefined && input.knownPriceUsdc !== null) {
    const n = Number(input.knownPriceUsdc);
    if (Number.isFinite(n) && n >= 0) {
      lowestPriceUsdc = n.toFixed(6);
    }
  } else if (probe) {
    lowestPriceUsdc = lowestAcceptUsdc(probe.accepts);
  }

  const gasUsd = Number(oracle.estimates.nativeTransfer.costUsd) || 0;
  const x402Usd = lowestPriceUsdc ? Number(lowestPriceUsdc) : 0;
  const total = gasUsd + x402Usd;

  let recommendation: string;
  if (probe?.dead) {
    recommendation =
      "Resource looks dead or misconfigured — do not pay. Try another Bazaar listing.";
  } else if (probe?.freeAccess) {
    recommendation =
      "Endpoint returned free access (2xx). No x402 payment needed; still budget gas if you transact on-chain.";
  } else if (probe?.paymentRequired) {
    recommendation = `Pay x402 (~$${lowestPriceUsdc ?? "?"} USDC) then settle on ${oracle.chain}. Prefer maxFee ${oracle.eip1559.standard.maxFeeGwei} gwei.`;
  } else {
    recommendation = `No resource probed. Budget ~$${gasUsd.toFixed(6)} gas for a native transfer on ${oracle.chain} at standard fees.`;
  }

  return {
    timestamp: new Date().toISOString(),
    chain: oracle.chain,
    gas: {
      gasPriceGwei: oracle.gasPriceGwei,
      maxFeeGwei: oracle.eip1559.standard.maxFeeGwei,
      maxPriorityFeeGwei: oracle.eip1559.standard.maxPriorityFeeGwei,
      nativeUsdPrice: oracle.nativeUsdPrice,
      nativeSymbol: oracle.nativeSymbol,
      transferCostUsd: oracle.estimates.nativeTransfer.costUsd,
      customCostUsd,
      customGasLimit,
    },
    x402: {
      probed: Boolean(probe),
      paymentRequired: probe?.paymentRequired ?? false,
      freeAccess: probe?.freeAccess ?? false,
      dead: probe?.dead ?? false,
      lowestPriceUsdc,
      accepts: probe?.accepts ?? [],
      latencyMs: probe?.latencyMs ?? null,
      status: probe?.status ?? null,
      error: probe?.error,
    },
    totalUsdEstimate: total.toFixed(6),
    recommendation,
  };
}
