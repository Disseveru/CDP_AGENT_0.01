/**
 * Multi-chain Gas Oracle for autonomous agents.
 *
 * Returns real-time EIP-1559 fee data, legacy gasPrice, USD cost estimates,
 * and recommended maxFee/maxPriorityFee for common tx types.
 *
 * Uses public RPC endpoints with short in-memory caching and graceful
 * multi-provider failover. No API keys required for the default path.
 */
import { createPublicClient, http, formatGwei, formatEther, type Chain } from "viem";
import {
  mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
  baseSepolia,
} from "viem/chains";

export type SupportedChainId =
  | "ethereum"
  | "base"
  | "arbitrum"
  | "optimism"
  | "polygon"
  | "base-sepolia";

interface ChainConfig {
  id: SupportedChainId;
  chainId: number;
  name: string;
  viemChain: Chain;
  /** Public RPC URLs tried in order (failover). */
  rpcs: string[];
  /** Native token symbol for display. */
  nativeSymbol: "ETH" | "MATIC" | "POL";
  /** Approximate native token USD price fallback when live feed fails. */
  nativeUsdFallback: number;
}

const CHAINS: Record<SupportedChainId, ChainConfig> = {
  ethereum: {
    id: "ethereum",
    chainId: 1,
    name: "Ethereum Mainnet",
    viemChain: mainnet,
    rpcs: [
      "https://ethereum.publicnode.com",
      "https://rpc.ankr.com/eth",
      "https://1rpc.io/eth",
    ],
    nativeSymbol: "ETH",
    nativeUsdFallback: 3200,
  },
  base: {
    id: "base",
    chainId: 8453,
    name: "Base",
    viemChain: base,
    rpcs: [
      "https://mainnet.base.org",
      "https://base.publicnode.com",
      "https://1rpc.io/base",
    ],
    nativeSymbol: "ETH",
    nativeUsdFallback: 3200,
  },
  arbitrum: {
    id: "arbitrum",
    chainId: 42161,
    name: "Arbitrum One",
    viemChain: arbitrum,
    rpcs: [
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum.publicnode.com",
      "https://1rpc.io/arb",
    ],
    nativeSymbol: "ETH",
    nativeUsdFallback: 3200,
  },
  optimism: {
    id: "optimism",
    chainId: 10,
    name: "Optimism",
    viemChain: optimism,
    rpcs: [
      "https://mainnet.optimism.io",
      "https://optimism.publicnode.com",
      "https://1rpc.io/op",
    ],
    nativeSymbol: "ETH",
    nativeUsdFallback: 3200,
  },
  polygon: {
    id: "polygon",
    chainId: 137,
    name: "Polygon PoS",
    viemChain: polygon,
    rpcs: [
      "https://polygon-rpc.com",
      "https://polygon.publicnode.com",
      "https://1rpc.io/matic",
    ],
    nativeSymbol: "POL",
    nativeUsdFallback: 0.45,
  },
  "base-sepolia": {
    id: "base-sepolia",
    chainId: 84532,
    name: "Base Sepolia",
    viemChain: baseSepolia,
    rpcs: [
      "https://sepolia.base.org",
      "https://base-sepolia.publicnode.com",
    ],
    nativeSymbol: "ETH",
    nativeUsdFallback: 3200,
  },
};

const DEFAULT_GAS_LIMITS = {
  transfer: 21_000n,
  erc20Transfer: 65_000n,
  swap: 250_000n,
  contractDeploy: 1_500_000n,
} as const;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const feeCache = new Map<string, CacheEntry<GasOracleResult>>();
const priceCache = new Map<string, CacheEntry<number>>();

const FEE_CACHE_TTL_MS = 12_000;
const PRICE_CACHE_TTL_MS = 60_000;
const RPC_TIMEOUT_MS = 8_000;

export interface FeeLevels {
  /** Suggested maxPriorityFeePerGas in gwei (string for JSON safety). */
  maxPriorityFeeGwei: string;
  /** Suggested maxFeePerGas in gwei. */
  maxFeeGwei: string;
  /** Base fee from latest block in gwei. */
  baseFeeGwei: string;
}

export interface CostEstimate {
  gasLimit: string;
  costNative: string;
  costUsd: string;
  label: string;
}

export interface GasOracleResult {
  chain: SupportedChainId;
  chainId: number;
  name: string;
  nativeSymbol: string;
  nativeUsdPrice: number;
  timestamp: string;
  blockNumber: string;
  /** Legacy gasPrice (gwei) for non-EIP-1559 clients. */
  gasPriceGwei: string;
  /** EIP-1559 suggested levels. */
  eip1559: {
    slow: FeeLevels;
    standard: FeeLevels;
    fast: FeeLevels;
  };
  /** Estimated costs for common operations at standard fees. */
  estimates: {
    nativeTransfer: CostEstimate;
    erc20Transfer: CostEstimate;
    swap: CostEstimate;
  };
  source: string;
  cached: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function fetchNativeUsdPrice(
  symbol: "ETH" | "MATIC" | "POL",
  fallback: number,
): Promise<number> {
  const cacheKey = symbol === "POL" ? "MATIC" : symbol;
  const cached = priceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const coinId = cacheKey === "ETH" ? "ethereum" : "matic-network";
  try {
    const res = await withTimeout(
      fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`, {
        headers: { accept: "application/json" },
      }),
      RPC_TIMEOUT_MS,
      "coingecko",
    );
    if (res.ok) {
      const data = (await res.json()) as Record<string, { usd?: number }>;
      const price = data[coinId]?.usd;
      if (typeof price === "number" && price > 0) {
        priceCache.set(cacheKey, { value: price, expiresAt: Date.now() + PRICE_CACHE_TTL_MS });
        return price;
      }
    }
  } catch {
    // fall through to fallback
  }
  return fallback;
}

function gweiFromWei(wei: bigint): string {
  return formatGwei(wei);
}

function buildFeeLevels(
  baseFee: bigint,
  prioritySlow: bigint,
  priorityStd: bigint,
  priorityFast: bigint,
): GasOracleResult["eip1559"] {
  // maxFee ≈ 2 * baseFee + priority (standard headroom for base-fee spikes)
  const maxFee = (priority: bigint) => baseFee * 2n + priority;
  return {
    slow: {
      baseFeeGwei: gweiFromWei(baseFee),
      maxPriorityFeeGwei: gweiFromWei(prioritySlow),
      maxFeeGwei: gweiFromWei(maxFee(prioritySlow)),
    },
    standard: {
      baseFeeGwei: gweiFromWei(baseFee),
      maxPriorityFeeGwei: gweiFromWei(priorityStd),
      maxFeeGwei: gweiFromWei(maxFee(priorityStd)),
    },
    fast: {
      baseFeeGwei: gweiFromWei(baseFee),
      maxPriorityFeeGwei: gweiFromWei(priorityFast),
      maxFeeGwei: gweiFromWei(maxFee(priorityFast)),
    },
  };
}

function estimateCost(
  maxFeeWei: bigint,
  gasLimit: bigint,
  nativeUsd: number,
  label: string,
): CostEstimate {
  const costWei = maxFeeWei * gasLimit;
  const costNative = formatEther(costWei);
  const costUsd = (Number(costNative) * nativeUsd).toFixed(6);
  return {
    gasLimit: gasLimit.toString(),
    costNative,
    costUsd,
    label,
  };
}

async function queryChainFees(
  cfg: ChainConfig,
): Promise<Omit<GasOracleResult, "nativeUsdPrice" | "estimates" | "cached">> {
  let lastError: unknown;

  for (const rpc of cfg.rpcs) {
    try {
      const client = createPublicClient({
        chain: cfg.viemChain,
        transport: http(rpc, { timeout: RPC_TIMEOUT_MS }),
      });

      const [block, gasPrice, feeHistory] = await withTimeout(
        Promise.all([
          client.getBlock({ blockTag: "latest" }),
          client.getGasPrice(),
          client
            .getFeeHistory({
              blockCount: 5,
              rewardPercentiles: [10, 50, 90],
            })
            .catch(() => null),
        ]),
        RPC_TIMEOUT_MS + 2000,
        `rpc ${rpc}`,
      );

      const baseFee = block.baseFeePerGas ?? gasPrice / 2n;

      let prioritySlow = 100_000_000n; // 0.1 gwei
      let priorityStd = 500_000_000n; // 0.5 gwei
      let priorityFast = 1_500_000_000n; // 1.5 gwei

      if (feeHistory?.reward && feeHistory.reward.length > 0) {
        const last = feeHistory.reward[feeHistory.reward.length - 1];
        if (last?.[0] !== undefined) prioritySlow = last[0] > 0n ? last[0] : prioritySlow;
        if (last?.[1] !== undefined) priorityStd = last[1] > 0n ? last[1] : priorityStd;
        if (last?.[2] !== undefined) priorityFast = last[2] > 0n ? last[2] : priorityFast;
      }

      // L2s often have tiny priority fees; clamp minimums sensibly per chain
      if (cfg.id === "base" || cfg.id === "optimism" || cfg.id === "arbitrum") {
        if (priorityStd < 10_000n) priorityStd = 10_000n;
        if (priorityFast < priorityStd) priorityFast = priorityStd * 2n;
      }

      return {
        chain: cfg.id,
        chainId: cfg.chainId,
        name: cfg.name,
        nativeSymbol: cfg.nativeSymbol,
        timestamp: new Date().toISOString(),
        blockNumber: block.number.toString(),
        gasPriceGwei: gweiFromWei(gasPrice),
        eip1559: buildFeeLevels(baseFee, prioritySlow, priorityStd, priorityFast),
        source: rpc,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `All RPCs failed for ${cfg.id}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export function listSupportedChains(): Array<{
  id: SupportedChainId;
  chainId: number;
  name: string;
}> {
  return Object.values(CHAINS).map((c) => ({
    id: c.id,
    chainId: c.chainId,
    name: c.name,
  }));
}

export function parseChainId(input: unknown): SupportedChainId {
  if (typeof input !== "string") {
    throw new Error(
      `chain must be one of: ${Object.keys(CHAINS).join(", ")}`,
    );
  }
  const key = input.trim().toLowerCase() as SupportedChainId;
  if (!(key in CHAINS)) {
    throw new Error(
      `Unsupported chain "${input}". Supported: ${Object.keys(CHAINS).join(", ")}`,
    );
  }
  return key;
}

/**
 * Primary oracle entry point. Cached for FEE_CACHE_TTL_MS per chain.
 */
export async function getGasOracle(chainInput: unknown): Promise<GasOracleResult> {
  const chainId = parseChainId(chainInput);
  const cached = feeCache.get(chainId);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.value, cached: true };
  }

  const cfg = CHAINS[chainId];
  const [fees, nativeUsd] = await Promise.all([
    queryChainFees(cfg),
    fetchNativeUsdPrice(cfg.nativeSymbol, cfg.nativeUsdFallback),
  ]);

  const standardMaxFeeWei =
    BigInt(
      Math.round(
        Number(fees.eip1559.standard.maxFeeGwei) * 1e9,
      ),
    ) || 1n;

  // Prefer exact wei from gwei string via parse if available; fall back above
  let maxFeeWei: bigint;
  try {
    // formatGwei inverse: gwei string * 1e9
    const parts = fees.eip1559.standard.maxFeeGwei.split(".");
    const whole = BigInt(parts[0] || "0");
    const frac = (parts[1] || "").padEnd(9, "0").slice(0, 9);
    maxFeeWei = whole * 1_000_000_000n + BigInt(frac || "0");
    if (maxFeeWei === 0n) maxFeeWei = standardMaxFeeWei;
  } catch {
    maxFeeWei = standardMaxFeeWei;
  }

  const result: GasOracleResult = {
    ...fees,
    nativeUsdPrice: nativeUsd,
    estimates: {
      nativeTransfer: estimateCost(
        maxFeeWei,
        DEFAULT_GAS_LIMITS.transfer,
        nativeUsd,
        "Native transfer (21k gas)",
      ),
      erc20Transfer: estimateCost(
        maxFeeWei,
        DEFAULT_GAS_LIMITS.erc20Transfer,
        nativeUsd,
        "ERC-20 transfer (~65k gas)",
      ),
      swap: estimateCost(
        maxFeeWei,
        DEFAULT_GAS_LIMITS.swap,
        nativeUsd,
        "DEX swap (~250k gas)",
      ),
    },
    cached: false,
  };

  feeCache.set(chainId, {
    value: result,
    expiresAt: Date.now() + FEE_CACHE_TTL_MS,
  });

  return result;
}

/**
 * Batch oracle for multiple chains in parallel.
 */
export async function getGasOracleBatch(
  chainsInput: unknown,
): Promise<{ results: GasOracleResult[]; errors: Record<string, string> }> {
  let chains: SupportedChainId[];
  if (chainsInput === undefined || chainsInput === null) {
    chains = ["base", "ethereum", "arbitrum", "optimism", "polygon"];
  } else if (Array.isArray(chainsInput)) {
    chains = chainsInput.map((c) => parseChainId(c));
  } else {
    throw new Error("chains must be an array of chain ids");
  }

  if (chains.length > 6) {
    throw new Error("Maximum 6 chains per batch request");
  }

  const results: GasOracleResult[] = [];
  const errors: Record<string, string> = {};

  await Promise.all(
    chains.map(async (c) => {
      try {
        results.push(await getGasOracle(c));
      } catch (error) {
        errors[c] = error instanceof Error ? error.message : String(error);
      }
    }),
  );

  results.sort((a, b) => a.chainId - b.chainId);
  return { results, errors };
}

/**
 * Estimate cost for a custom gas limit on a chain at standard fees.
 */
export async function estimateTxCost(input: {
  chain: unknown;
  gasLimit: unknown;
}): Promise<{
  chain: SupportedChainId;
  gasLimit: string;
  maxFeeGwei: string;
  costNative: string;
  costUsd: string;
  nativeSymbol: string;
  nativeUsdPrice: number;
  timestamp: string;
}> {
  const chainId = parseChainId(input.chain);
  const gasLimitRaw = input.gasLimit;
  const gasLimit =
    typeof gasLimitRaw === "number"
      ? BigInt(Math.floor(gasLimitRaw))
      : typeof gasLimitRaw === "string"
        ? BigInt(gasLimitRaw)
        : null;

  if (gasLimit === null || gasLimit <= 0n || gasLimit > 30_000_000n) {
    throw new Error("gasLimit must be a positive integer <= 30_000_000");
  }

  const oracle = await getGasOracle(chainId);
  const parts = oracle.eip1559.standard.maxFeeGwei.split(".");
  const whole = BigInt(parts[0] || "0");
  const frac = (parts[1] || "").padEnd(9, "0").slice(0, 9);
  const maxFeeWei = whole * 1_000_000_000n + BigInt(frac || "0");

  const cost = estimateCost(maxFeeWei, gasLimit, oracle.nativeUsdPrice, "custom");

  return {
    chain: chainId,
    gasLimit: gasLimit.toString(),
    maxFeeGwei: oracle.eip1559.standard.maxFeeGwei,
    costNative: cost.costNative,
    costUsd: cost.costUsd,
    nativeSymbol: oracle.nativeSymbol,
    nativeUsdPrice: oracle.nativeUsdPrice,
    timestamp: oracle.timestamp,
  };
}
