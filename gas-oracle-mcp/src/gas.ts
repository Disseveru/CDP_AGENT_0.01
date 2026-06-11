/**
 * Gas intelligence engine.
 *
 * Pulls live EIP-1559 fee data from Base, Ethereum, Arbitrum, and Optimism
 * over public RPCs, plus the ETH-USD spot rate from Coinbase, and produces
 * machine-readable cost comparisons for autonomous agents.
 */
import { createPublicClient, http, formatGwei, type PublicClient } from "viem";
import { arbitrum, base, mainnet, optimism } from "viem/chains";

interface TrackedChain {
  key: string;
  label: string;
  client: PublicClient;
}

const CHAINS: TrackedChain[] = [
  { key: "base", label: "Base", client: createPublicClient({ chain: base, transport: http() }) as PublicClient },
  { key: "ethereum", label: "Ethereum", client: createPublicClient({ chain: mainnet, transport: http() }) as PublicClient },
  { key: "arbitrum", label: "Arbitrum One", client: createPublicClient({ chain: arbitrum, transport: http() }) as PublicClient },
  { key: "optimism", label: "OP Mainnet", client: createPublicClient({ chain: optimism, transport: http() }) as PublicClient },
];

/** Typical gas usage per transaction archetype. */
const TX_GAS_UNITS: Record<string, bigint> = {
  transfer: 21_000n,
  erc20_transfer: 65_000n,
  swap: 200_000n,
  nft_mint: 150_000n,
};

export const TX_TYPES = Object.keys(TX_GAS_UNITS);

export interface ChainGasInfo {
  chain: string;
  label: string;
  chainId: number;
  maxFeePerGasWei: string;
  maxFeePerGasGwei: string;
  maxPriorityFeePerGasGwei: string | null;
  blockNumber: string;
}

export interface GasSnapshot {
  timestamp: string;
  ethUsd: number;
  chains: ChainGasInfo[];
  errors: Record<string, string>;
}

let cache: { at: number; snapshot: GasSnapshot } | null = null;
const CACHE_TTL_MS = 5_000;
const WEI_PER_ETH = 10n ** 18n;
const USD_DECIMALS = 6;

function roundDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function formatScaled(value: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(decimals, "0");
  return `${whole}.${fraction}`;
}

function formatWeiAsEth(value: bigint, decimals: number): string {
  const scaled = roundDiv(value * 10n ** BigInt(decimals), WEI_PER_ETH);
  return formatScaled(scaled, decimals);
}

async function fetchEthUsd(): Promise<number> {
  const res = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot");
  if (!res.ok) throw new Error(`Coinbase spot price API returned ${res.status}`);
  const body = (await res.json()) as { data: { amount: string } };
  return Number(body.data.amount);
}

async function fetchChainGas(chain: TrackedChain): Promise<ChainGasInfo> {
  const [fees, blockNumber] = await Promise.all([
    chain.client.estimateFeesPerGas().catch(async () => {
      const gasPrice = await chain.client.getGasPrice();
      return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: null };
    }),
    chain.client.getBlockNumber(),
  ]);

  return {
    chain: chain.key,
    label: chain.label,
    chainId: chain.client.chain!.id,
    maxFeePerGasWei: fees.maxFeePerGas!.toString(),
    maxFeePerGasGwei: formatGwei(fees.maxFeePerGas!),
    maxPriorityFeePerGasGwei:
      fees.maxPriorityFeePerGas != null ? formatGwei(fees.maxPriorityFeePerGas) : null,
    blockNumber: blockNumber.toString(),
  };
}

/** Live multi-chain gas snapshot, cached for 5 seconds. */
export async function getGasSnapshot(): Promise<GasSnapshot> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.snapshot;
  }

  const errors: Record<string, string> = {};
  const [ethUsd, ...chainResults] = await Promise.all([
    fetchEthUsd(),
    ...CHAINS.map((chain) =>
      fetchChainGas(chain).catch((err: Error) => {
        errors[chain.key] = err.message;
        return null;
      }),
    ),
  ]);

  const snapshot: GasSnapshot = {
    timestamp: new Date().toISOString(),
    ethUsd,
    chains: chainResults.filter((c): c is ChainGasInfo => c !== null),
    errors,
  };

  if (snapshot.chains.length === 0) {
    throw new Error(`All chain RPCs failed: ${JSON.stringify(errors)}`);
  }

  cache = { at: Date.now(), snapshot };
  return snapshot;
}

export interface ChainCostEstimate {
  chain: string;
  label: string;
  chainId: number;
  estimatedFeeEth: string;
  estimatedFeeUsd: string;
  maxFeePerGasGwei: string;
}

export interface Recommendation {
  timestamp: string;
  txType: string;
  gasUnits: string;
  ethUsd: number;
  cheapest: ChainCostEstimate;
  ranking: ChainCostEstimate[];
  maxSavingsUsd: string;
}

/** Ranks tracked chains by estimated execution cost for a tx archetype. */
export async function recommendCheapestChain(txType: string): Promise<Recommendation> {
  const gasUnits = TX_GAS_UNITS[txType];
  if (!gasUnits) {
    throw new Error(`Unknown txType "${txType}". Valid values: ${TX_TYPES.join(", ")}`);
  }

  const snapshot = await getGasSnapshot();
  const ethUsdScaled = BigInt(Math.round(snapshot.ethUsd * 10 ** USD_DECIMALS));

  const rankedCosts = snapshot.chains
    .map((chain) => {
      const feeWei = BigInt(chain.maxFeePerGasWei) * gasUnits;
      const feeUsdScaled = roundDiv(feeWei * ethUsdScaled, WEI_PER_ETH);
      return {
        chain: chain.chain,
        label: chain.label,
        chainId: chain.chainId,
        estimatedFeeEth: formatWeiAsEth(feeWei, 10),
        estimatedFeeUsd: formatScaled(feeUsdScaled, USD_DECIMALS),
        feeUsdScaled,
        maxFeePerGasGwei: chain.maxFeePerGasGwei,
      };
    })
    .sort((a, b) => (a.feeUsdScaled < b.feeUsdScaled ? -1 : a.feeUsdScaled > b.feeUsdScaled ? 1 : 0));

  const cheapest = rankedCosts[0];
  const mostExpensive = rankedCosts[rankedCosts.length - 1];
  const ranking = rankedCosts.map(({ feeUsdScaled: _feeUsdScaled, ...chain }) => chain);

  return {
    timestamp: snapshot.timestamp,
    txType,
    gasUnits: gasUnits.toString(),
    ethUsd: snapshot.ethUsd,
    cheapest,
    ranking,
    maxSavingsUsd: formatScaled(mostExpensive.feeUsdScaled - cheapest.feeUsdScaled, USD_DECIMALS),
  };
}
