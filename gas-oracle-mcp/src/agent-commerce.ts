/**
 * High-frequency agent-to-agent commerce primitives.
 *
 * Agents repeatedly fail x402 purchases because they lack USDC, native gas,
 * or a cheap go/no-go check before signing. These SKUs bundle existing
 * read-only RPC calls into one paid answer.
 */
import { getBalance, type GasNetwork } from "./gas.js";
import {
  estimateTxCost,
  getGasOracle,
  parseChainId,
  type SupportedChainId,
} from "./gas-oracle.js";

const USDC: Partial<Record<GasNetwork, `0x${string}`>> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
};

function mapChainToGasNetwork(chain: SupportedChainId): GasNetwork {
  if (chain === "base-sepolia") {
    throw new Error("agent commerce tools use mainnet networks only");
  }
  return chain;
}

function parseUsdAmount(raw: unknown, label: string): number {
  const value = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/^\$/, ""));
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new Error(`${label} must be a number between 0 and 1000000`);
  }
  return value;
}

export async function agentFuelCheck(input: {
  address: unknown;
  chain?: unknown;
}): Promise<{
  timestamp: string;
  chain: SupportedChainId;
  address: string;
  native: {
    symbol: string;
    balance: string;
    usdPrice: number;
    usdValue: string;
  };
  usdc: {
    contract: string | null;
    balance: string;
    available: boolean;
  };
  gas: {
    maxFeeGwei: string;
    nativeTransferUsd: string;
    erc20TransferUsd: string;
  };
  readyForX402: boolean;
  blockers: string[];
}> {
  const chain = parseChainId(input.chain ?? "base");
  const network = mapChainToGasNetwork(chain);
  const address = String(input.address || "").trim();
  if (!address) throw new Error("address is required");

  const [oracle, nativeBal, usdcBal] = await Promise.all([
    getGasOracle(chain),
    getBalance({ address, network }),
    USDC[network]
      ? getBalance({ address, network, token: USDC[network] }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const nativeUsdValue = (Number(nativeBal.balance) * oracle.nativeUsdPrice).toFixed(6);
  const usdcBalance = usdcBal ? usdcBal.balance : "0";
  const usdcAvailable = Boolean(usdcBal) && Number(usdcBalance) > 0;
  const blockers: string[] = [];
  if (Number(nativeBal.balance) <= 0) blockers.push("no_native_gas");
  if (!usdcAvailable) blockers.push("no_usdc");

  return {
    timestamp: new Date().toISOString(),
    chain,
    address: nativeBal.address,
    native: {
      symbol: nativeBal.symbol,
      balance: nativeBal.balance,
      usdPrice: oracle.nativeUsdPrice,
      usdValue: nativeUsdValue,
    },
    usdc: {
      contract: USDC[network] ?? null,
      balance: usdcBalance,
      available: usdcAvailable,
    },
    gas: {
      maxFeeGwei: oracle.eip1559.standard.maxFeeGwei,
      nativeTransferUsd: oracle.estimates.nativeTransfer.costUsd,
      erc20TransferUsd: oracle.estimates.erc20Transfer.costUsd,
    },
    readyForX402: blockers.length === 0,
    blockers,
  };
}

export async function x402SettlementReady(input: {
  address: unknown;
  amountUsd?: unknown;
  chain?: unknown;
}): Promise<{
  timestamp: string;
  chain: SupportedChainId;
  address: string;
  requiredUsd: string;
  usdcBalance: string;
  nativeBalance: string;
  estimatedGasUsd: string;
  canPayQuotedAmount: boolean;
  canCoverGas: boolean;
  ready: boolean;
  shortfallUsd: string;
  recommendation: string;
}> {
  const requiredUsd = parseUsdAmount(input.amountUsd ?? 0.01, "amountUsd");
  const fuel = await agentFuelCheck({ address: input.address, chain: input.chain });
  const usdc = Number(fuel.usdc.balance);
  const nativeUsd = Number(fuel.native.usdValue);
  const gasUsd = Number(fuel.gas.erc20TransferUsd);
  const canPayQuotedAmount = usdc + 1e-12 >= requiredUsd;
  const canCoverGas = nativeUsd >= gasUsd || Number(fuel.native.balance) > 0;
  const shortfall = Math.max(0, requiredUsd - usdc);

  let recommendation = "Wallet can settle this x402 quote on the requested chain.";
  if (!canPayQuotedAmount && !canCoverGas) {
    recommendation = `Fund ${shortfall.toFixed(6)} more USDC and add native gas before calling the paid endpoint.`;
  } else if (!canPayQuotedAmount) {
    recommendation = `Fund ${shortfall.toFixed(6)} more USDC. Native gas looks present.`;
  } else if (!canCoverGas) {
    recommendation = "USDC is sufficient, but native gas is missing so settlement or follow-up txs may fail.";
  }

  return {
    timestamp: fuel.timestamp,
    chain: fuel.chain,
    address: fuel.address,
    requiredUsd: requiredUsd.toFixed(6),
    usdcBalance: fuel.usdc.balance,
    nativeBalance: fuel.native.balance,
    estimatedGasUsd: fuel.gas.erc20TransferUsd,
    canPayQuotedAmount,
    canCoverGas,
    ready: canPayQuotedAmount && fuel.readyForX402,
    shortfallUsd: shortfall.toFixed(6),
    recommendation,
  };
}

export async function txPlan(input: {
  address: unknown;
  chain?: unknown;
  gasLimit?: unknown;
}): Promise<{
  timestamp: string;
  chain: SupportedChainId;
  address: string;
  oracle: Awaited<ReturnType<typeof getGasOracle>>;
  customEstimate: Awaited<ReturnType<typeof estimateTxCost>> | null;
  fuel: Awaited<ReturnType<typeof agentFuelCheck>>;
  affordable: boolean;
}> {
  const chain = parseChainId(input.chain ?? "base");
  const [oracle, fuel, customEstimate] = await Promise.all([
    getGasOracle(chain),
    agentFuelCheck({ address: input.address, chain }),
    input.gasLimit !== undefined && input.gasLimit !== null
      ? estimateTxCost({ chain, gasLimit: input.gasLimit })
      : Promise.resolve(null),
  ]);

  const neededUsd = Number(
    customEstimate?.costUsd ?? oracle.estimates.erc20Transfer.costUsd,
  );
  const affordable = Number(fuel.native.usdValue) >= neededUsd;

  return {
    timestamp: new Date().toISOString(),
    chain,
    address: fuel.address,
    oracle,
    customEstimate,
    fuel,
    affordable,
  };
}

export function usdcContract(network: GasNetwork): string | undefined {
  return USDC[network];
}

export function parseUsdAmountForTest(raw: unknown): number {
  return parseUsdAmount(raw, "amountUsd");
}
