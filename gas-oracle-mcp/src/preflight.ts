/**
 * Transaction preflight engine.
 *
 * Simulates EVM calls before agents sign or broadcast transactions so they
 * can avoid reverts, wasted gas, and bad token transfers. Uses public RPCs
 * via viem — no proprietary oracle, but the *simulation for specific calldata*
 * is something agents need on every execution attempt.
 */
import {
  createPublicClient,
  erc20Abi,
  formatEther,
  formatGwei,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
  type Chain,
  type PublicClient,
} from "viem";
import { arbitrum, base, baseSepolia, mainnet, optimism } from "viem/chains";

export const SUPPORTED_CHAINS = ["base", "base-sepolia", "ethereum", "arbitrum", "optimism"] as const;
export type ChainKey = (typeof SUPPORTED_CHAINS)[number];

const CHAIN_MAP: Record<ChainKey, Chain> = {
  base,
  "base-sepolia": baseSepolia,
  ethereum: mainnet,
  arbitrum,
  optimism,
};

function getClient(chainKey: ChainKey): PublicClient {
  return createPublicClient({
    chain: CHAIN_MAP[chainKey],
    transport: http(),
  });
}

function assertAddress(value: string, field: string): `0x${string}` {
  if (!isAddress(value)) {
    throw new Error(`Invalid ${field}: "${value}" is not a checksummed EVM address`);
  }
  return getAddress(value);
}

function extractRevertMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return error instanceof Error ? error.message : String(error);
  }
  const err = error as { shortMessage?: string; message?: string; cause?: unknown };
  if (err.shortMessage) return err.shortMessage;
  if (err.cause) return extractRevertMessage(err.cause);
  return err.message ?? "Unknown revert";
}

export interface SimulateTransactionInput {
  chain: ChainKey;
  from: string;
  to: string;
  data?: string;
  value?: string;
}

export interface SimulateTransactionResult {
  timestamp: string;
  chain: ChainKey;
  chainId: number;
  from: string;
  to: string;
  data: string;
  valueWei: string;
  willSucceed: boolean;
  gasEstimate: string | null;
  estimatedFeeWei: string | null;
  estimatedFeeEth: string | null;
  maxFeePerGasGwei: string | null;
  revertReason: string | null;
  warnings: string[];
  blockNumber: string;
}

/** Dry-runs an arbitrary transaction against current chain state. */
export async function simulateTransaction(input: SimulateTransactionInput): Promise<SimulateTransactionResult> {
  const client = getClient(input.chain);
  const from = assertAddress(input.from, "from");
  const to = assertAddress(input.to, "to");
  const data = (input.data?.startsWith("0x") ? input.data : `0x${input.data ?? ""}`) as `0x${string}`;
  const value = BigInt(input.value ?? "0");
  const warnings: string[] = [];

  const blockNumber = await client.getBlockNumber();

  if (data.length > 2) {
    const code = await client.getBytecode({ address: to });
    if (!code || code === "0x") {
      warnings.push("Target has no contract bytecode; non-empty calldata will likely revert.");
    }
  }

  const nativeBalance = await client.getBalance({ address: from });
  if (nativeBalance < value) {
    warnings.push(
      `Insufficient native balance for value: have ${formatEther(nativeBalance)} ETH, need ${formatEther(value)} ETH.`,
    );
  }

  let maxFeePerGas: bigint;
  try {
    const fees = await client.estimateFeesPerGas();
    maxFeePerGas = fees.maxFeePerGas ?? (await client.getGasPrice());
  } catch {
    maxFeePerGas = await client.getGasPrice();
  }

  let gasEstimate: bigint | null = null;
  let willSucceed = false;
  let revertReason: string | null = null;

  try {
    gasEstimate = await client.estimateGas({ account: from, to, data, value });
    await client.call({ account: from, to, data, value });
    willSucceed = true;
  } catch (error) {
    revertReason = extractRevertMessage(error);
    try {
      gasEstimate = await client.estimateGas({ account: from, to, data, value });
    } catch {
      // estimateGas can fail on hard reverts — that's fine.
    }
  }

  const estimatedFeeWei = gasEstimate != null ? gasEstimate * maxFeePerGas : null;
  if (estimatedFeeWei != null && nativeBalance < value + estimatedFeeWei) {
    warnings.push(
      `Insufficient native balance for value + max gas fee: need ~${formatEther(value + estimatedFeeWei)} ETH total.`,
    );
  }

  return {
    timestamp: new Date().toISOString(),
    chain: input.chain,
    chainId: client.chain!.id,
    from,
    to,
    data,
    valueWei: value.toString(),
    willSucceed,
    gasEstimate: gasEstimate?.toString() ?? null,
    estimatedFeeWei: estimatedFeeWei?.toString() ?? null,
    estimatedFeeEth: estimatedFeeWei != null ? formatEther(estimatedFeeWei) : null,
    maxFeePerGasGwei: formatGwei(maxFeePerGas),
    revertReason,
    warnings,
    blockNumber: blockNumber.toString(),
  };
}

export interface SimulateErc20TransferInput {
  chain: ChainKey;
  token: string;
  from: string;
  to: string;
  /** Human-readable amount, e.g. "10.5" (uses token decimals). */
  amount: string;
}

export interface SimulateErc20TransferResult {
  timestamp: string;
  chain: ChainKey;
  chainId: number;
  token: string;
  symbol: string;
  decimals: number;
  from: string;
  to: string;
  amount: string;
  amountWei: string;
  balanceWei: string;
  balanceFormatted: string;
  willSucceed: boolean;
  gasEstimate: string | null;
  estimatedFeeWei: string | null;
  estimatedFeeEth: string | null;
  revertReason: string | null;
  warnings: string[];
  blockNumber: string;
}

/** Dry-runs an ERC-20 transfer — the most common paid action agents take. */
export async function simulateErc20Transfer(
  input: SimulateErc20TransferInput,
): Promise<SimulateErc20TransferResult> {
  const client = getClient(input.chain);
  const token = assertAddress(input.token, "token");
  const from = assertAddress(input.from, "from");
  const to = assertAddress(input.to, "to");
  const warnings: string[] = [];

  let decimals: number;
  let symbol: string;
  try {
    [decimals, symbol] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    ]);
  } catch {
    throw new Error(`"${token}" is not a readable ERC-20 on ${input.chain} (decimals/symbol call failed)`);
  }

  const amountWei = parseUnits(input.amount, decimals);
  const balanceWei = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [from],
  });

  if (balanceWei < amountWei) {
    warnings.push(
      `Insufficient ${symbol} balance: have ${formatUnits(balanceWei, decimals)}, need ${input.amount}.`,
    );
  }

  const nativeBalance = await client.getBalance({ address: from });
  if (nativeBalance === 0n) {
    warnings.push("Sender has zero native balance; transaction may fail for lack of gas.");
  }

  const blockNumber = await client.getBlockNumber();

  let maxFeePerGas: bigint;
  try {
    const fees = await client.estimateFeesPerGas();
    maxFeePerGas = fees.maxFeePerGas ?? (await client.getGasPrice());
  } catch {
    maxFeePerGas = await client.getGasPrice();
  }

  let gasEstimate: bigint | null = null;
  let willSucceed = false;
  let revertReason: string | null = null;

  try {
    const { request } = await client.simulateContract({
      address: token,
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, amountWei],
      account: from,
    });
    gasEstimate = await client.estimateContractGas(request);
    willSucceed = true;
  } catch (error) {
    revertReason = extractRevertMessage(error);
    try {
      gasEstimate = await client.estimateContractGas({
        address: token,
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, amountWei],
        account: from,
      });
    } catch {
      // ignore
    }
  }

  const estimatedFeeWei = gasEstimate != null ? gasEstimate * maxFeePerGas : null;

  return {
    timestamp: new Date().toISOString(),
    chain: input.chain,
    chainId: client.chain!.id,
    token,
    symbol,
    decimals,
    from,
    to,
    amount: input.amount,
    amountWei: amountWei.toString(),
    balanceWei: balanceWei.toString(),
    balanceFormatted: formatUnits(balanceWei, decimals),
    willSucceed,
    gasEstimate: gasEstimate?.toString() ?? null,
    estimatedFeeWei: estimatedFeeWei?.toString() ?? null,
    estimatedFeeEth: estimatedFeeWei != null ? formatEther(estimatedFeeWei) : null,
    revertReason,
    warnings,
    blockNumber: blockNumber.toString(),
  };
}
