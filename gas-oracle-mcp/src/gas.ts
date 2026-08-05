/**
 * On-chain gas oracle + balance + tx status for autonomous agents.
 *
 * Uses public RPC endpoints via viem with hard timeouts. No private keys,
 * no writes — read-only primitives agents need before every on-chain action.
 */
import {
  createPublicClient,
  formatEther,
  formatGwei,
  formatUnits,
  http,
  isAddress,
  isHash,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import { arbitrum, base, mainnet, optimism, polygon } from "viem/chains";

const RPC_TIMEOUT_MS = 12_000;

/** Supported networks for gas/balance/tx tools. */
export type GasNetwork = "base" | "ethereum" | "arbitrum" | "optimism" | "polygon";

const CHAIN_BY_NETWORK: Record<GasNetwork, Chain> = {
  base,
  ethereum: mainnet,
  arbitrum,
  optimism,
  polygon,
};

/** Public RPC URLs (overridable via env for production hardening). */
const DEFAULT_RPC: Record<GasNetwork, string> = {
  base: process.env.RPC_BASE || "https://mainnet.base.org",
  ethereum: process.env.RPC_ETHEREUM || "https://ethereum.publicnode.com",
  arbitrum: process.env.RPC_ARBITRUM || "https://arb1.arbitrum.io/rpc",
  optimism: process.env.RPC_OPTIMISM || "https://mainnet.optimism.io",
  polygon: process.env.RPC_POLYGON || "https://polygon-rpc.com",
};

const clientCache = new Map<GasNetwork, PublicClient>();

function getClient(network: GasNetwork): PublicClient {
  const cached = clientCache.get(network);
  if (cached) return cached;

  const chain = CHAIN_BY_NETWORK[network];
  const client = createPublicClient({
    chain,
    transport: http(DEFAULT_RPC[network], {
      timeout: RPC_TIMEOUT_MS,
      retryCount: 1,
      retryDelay: 250,
    }),
  });
  clientCache.set(network, client);
  return client;
}

function parseNetwork(raw: unknown): GasNetwork {
  const value = String(raw || "base").toLowerCase().trim();
  if (value === "eth" || value === "mainnet") return "ethereum";
  if (value === "arb") return "arbitrum";
  if (value === "op") return "optimism";
  if (value === "matic" || value === "pol") return "polygon";
  if (
    value === "base" ||
    value === "ethereum" ||
    value === "arbitrum" ||
    value === "optimism" ||
    value === "polygon"
  ) {
    return value;
  }
  throw new Error(
    `Unsupported network "${raw}". Use: base, ethereum, arbitrum, optimism, polygon`,
  );
}

function parseAddress(raw: unknown, label = "address"): Address {
  const value = String(raw || "").trim();
  if (!isAddress(value)) {
    throw new Error(`Invalid ${label}: "${raw}"`);
  }
  return value as Address;
}

function parseTxHash(raw: unknown): Hash {
  const value = String(raw || "").trim();
  if (!isHash(value)) {
    throw new Error(`Invalid transaction hash: "${raw}"`);
  }
  return value as Hash;
}

// ---------------------------------------------------------------------------
// gas_oracle
// ---------------------------------------------------------------------------

export interface GasOracleInput {
  /** One network or "all" for a multi-chain snapshot. Default: base */
  network?: string;
}

export interface GasOracleNetworkResult {
  network: GasNetwork;
  chainId: number;
  /** Gas price in wei (string) */
  gasPriceWei: string;
  /** Gas price in gwei */
  gasPriceGwei: string;
  /** EIP-1559 base fee in gwei when available */
  baseFeeGwei: string | null;
  /** Suggested max priority fee (tip) in gwei when available */
  maxPriorityFeeGwei: string | null;
  /** Suggested max fee per gas in gwei when available */
  maxFeePerGasGwei: string | null;
  blockNumber: string;
  fetchedInMs: number;
  error?: string;
}

export interface GasOracleResult {
  timestamp: string;
  networks: GasOracleNetworkResult[];
}

async function fetchGasForNetwork(network: GasNetwork): Promise<GasOracleNetworkResult> {
  const started = Date.now();
  const client = getClient(network);
  const chain = CHAIN_BY_NETWORK[network];

  try {
    const [gasPrice, block, fees] = await Promise.all([
      client.getGasPrice(),
      client.getBlock({ blockTag: "latest" }),
      client.estimateFeesPerGas().catch(() => null),
    ]);

    const baseFee =
      block.baseFeePerGas !== null && block.baseFeePerGas !== undefined
        ? formatGwei(block.baseFeePerGas)
        : null;

    return {
      network,
      chainId: chain.id,
      gasPriceWei: gasPrice.toString(),
      gasPriceGwei: formatGwei(gasPrice),
      baseFeeGwei: baseFee,
      maxPriorityFeeGwei: fees?.maxPriorityFeePerGas
        ? formatGwei(fees.maxPriorityFeePerGas)
        : null,
      maxFeePerGasGwei: fees?.maxFeePerGas ? formatGwei(fees.maxFeePerGas) : null,
      blockNumber: block.number.toString(),
      fetchedInMs: Date.now() - started,
    };
  } catch (error) {
    return {
      network,
      chainId: chain.id,
      gasPriceWei: "0",
      gasPriceGwei: "0",
      baseFeeGwei: null,
      maxPriorityFeeGwei: null,
      maxFeePerGasGwei: null,
      blockNumber: "0",
      fetchedInMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Live gas prices for one network or all supported chains. */
export async function getGasOracle(input: GasOracleInput = {}): Promise<GasOracleResult> {
  const raw = (input.network || "base").toLowerCase().trim();
  const networks: GasNetwork[] =
    raw === "all"
      ? ["base", "ethereum", "arbitrum", "optimism", "polygon"]
      : [parseNetwork(raw)];

  const results = await Promise.all(networks.map((n) => fetchGasForNetwork(n)));

  return {
    timestamp: new Date().toISOString(),
    networks: results,
  };
}

// ---------------------------------------------------------------------------
// get_balance
// ---------------------------------------------------------------------------

const ERC20_BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

export interface GetBalanceInput {
  address: string;
  network?: string;
  /** Optional ERC-20 contract address. When omitted, returns native balance. */
  token?: string;
}

export interface GetBalanceResult {
  timestamp: string;
  network: GasNetwork;
  chainId: number;
  address: string;
  token: string | null;
  symbol: string;
  decimals: number;
  balanceWei: string;
  balance: string;
  fetchedInMs: number;
}

/** Native or ERC-20 balance for an address on a supported network. */
export async function getBalance(input: GetBalanceInput): Promise<GetBalanceResult> {
  const started = Date.now();
  const network = parseNetwork(input.network || "base");
  const address = parseAddress(input.address);
  const client = getClient(network);
  const chain = CHAIN_BY_NETWORK[network];

  if (!input.token) {
    const balanceWei = await client.getBalance({ address });
    return {
      timestamp: new Date().toISOString(),
      network,
      chainId: chain.id,
      address,
      token: null,
      symbol: chain.nativeCurrency.symbol,
      decimals: chain.nativeCurrency.decimals,
      balanceWei: balanceWei.toString(),
      balance: formatEther(balanceWei),
      fetchedInMs: Date.now() - started,
    };
  }

  const token = parseAddress(input.token, "token");
  const [rawBalance, decimals, symbol] = await Promise.all([
    client.readContract({
      address: token,
      abi: ERC20_BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [address],
    }),
    client.readContract({
      address: token,
      abi: ERC20_BALANCE_OF_ABI,
      functionName: "decimals",
    }),
    client
      .readContract({
        address: token,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "symbol",
      })
      .catch(() => "TOKEN"),
  ]);

  return {
    timestamp: new Date().toISOString(),
    network,
    chainId: chain.id,
    address,
    token,
    symbol: String(symbol),
    decimals: Number(decimals),
    balanceWei: rawBalance.toString(),
    balance: formatUnits(rawBalance, Number(decimals)),
    fetchedInMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// get_tx_status
// ---------------------------------------------------------------------------

export interface GetTxStatusInput {
  hash: string;
  network?: string;
}

export interface GetTxStatusResult {
  timestamp: string;
  network: GasNetwork;
  chainId: number;
  hash: string;
  status: "pending" | "success" | "reverted" | "not_found";
  blockNumber: string | null;
  blockHash: string | null;
  from: string | null;
  to: string | null;
  valueWei: string | null;
  value: string | null;
  gasUsed: string | null;
  effectiveGasPriceWei: string | null;
  effectiveGasPriceGwei: string | null;
  transactionIndex: number | null;
  fetchedInMs: number;
}

/** Transaction receipt / pending status for a hash on a supported network. */
export async function getTxStatus(input: GetTxStatusInput): Promise<GetTxStatusResult> {
  const started = Date.now();
  const network = parseNetwork(input.network || "base");
  const hash = parseTxHash(input.hash);
  const client = getClient(network);
  const chain = CHAIN_BY_NETWORK[network];

  const [receipt, tx] = await Promise.all([
    client.getTransactionReceipt({ hash }).catch(() => null),
    client.getTransaction({ hash }).catch(() => null),
  ]);

  if (!receipt && !tx) {
    return {
      timestamp: new Date().toISOString(),
      network,
      chainId: chain.id,
      hash,
      status: "not_found",
      blockNumber: null,
      blockHash: null,
      from: null,
      to: null,
      valueWei: null,
      value: null,
      gasUsed: null,
      effectiveGasPriceWei: null,
      effectiveGasPriceGwei: null,
      transactionIndex: null,
      fetchedInMs: Date.now() - started,
    };
  }

  if (!receipt) {
    return {
      timestamp: new Date().toISOString(),
      network,
      chainId: chain.id,
      hash,
      status: "pending",
      blockNumber: null,
      blockHash: null,
      from: tx?.from ?? null,
      to: (tx?.to as string | null) ?? null,
      valueWei: tx?.value?.toString() ?? null,
      value: tx?.value !== undefined ? formatEther(tx.value) : null,
      gasUsed: null,
      effectiveGasPriceWei: null,
      effectiveGasPriceGwei: null,
      transactionIndex: null,
      fetchedInMs: Date.now() - started,
    };
  }

  const effectiveGasPrice = receipt.effectiveGasPrice;
  return {
    timestamp: new Date().toISOString(),
    network,
    chainId: chain.id,
    hash,
    status: receipt.status === "success" ? "success" : "reverted",
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    from: receipt.from,
    to: (receipt.to as string | null) ?? null,
    valueWei: tx?.value?.toString() ?? null,
    value: tx?.value !== undefined ? formatEther(tx.value) : null,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPriceWei: effectiveGasPrice?.toString() ?? null,
    effectiveGasPriceGwei: effectiveGasPrice ? formatGwei(effectiveGasPrice) : null,
    transactionIndex: receipt.transactionIndex,
    fetchedInMs: Date.now() - started,
  };
}

/** Exported for tests — clear cached clients between runs. */
export function _resetGasClientCache(): void {
  clientCache.clear();
}

/** Keep Hex available for future on-chain helpers. */
export type { Hex };
