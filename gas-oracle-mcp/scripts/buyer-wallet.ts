import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CdpEvmWalletProvider, CdpSmartWalletProvider } from "@coinbase/agentkit";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import type { ClientEvmSigner } from "@x402/evm";
import { toClientEvmSigner } from "@x402/evm";
import { encodeFunctionData, erc20Abi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { resolveCdpCredentials } from "../src/wallet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUYER_KEY_PATH = path.join(__dirname, "..", ".buyer_key");
const SMART_WALLET_DATA_PATH = path.join(__dirname, "..", ".smart_buyer_wallet.json");

type AgentKitNetworkId = "base-sepolia" | "base-mainnet";

const RPC_URLS: Record<AgentKitNetworkId, string> = {
  "base-sepolia": "https://sepolia.base.org",
  "base-mainnet": "https://mainnet.base.org",
};

const USDC_BY_NETWORK: Record<AgentKitNetworkId, `0x${string}`> = {
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "base-mainnet": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

interface SmartWalletData {
  address: string;
  ownerAddress: string;
  name?: string;
}

function loadSmartWalletData(): SmartWalletData | undefined {
  try {
    return JSON.parse(fs.readFileSync(SMART_WALLET_DATA_PATH, "utf8")) as SmartWalletData;
  } catch {
    return undefined;
  }
}

function saveSmartWalletData(data: SmartWalletData): void {
  fs.writeFileSync(SMART_WALLET_DATA_PATH, JSON.stringify(data, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function resolveBasePaymasterUrl(
  credentials: ReturnType<typeof resolveCdpCredentials>,
  networkId: AgentKitNetworkId,
): Promise<string> {
  const explicit =
    process.env.PAYMASTER_URL ||
    process.env.BASE_PAYMASTER_URL ||
    process.env.CDP_PAYMASTER_URL;
  if (explicit) {
    return explicit;
  }

  const paymasterNetwork = networkId === "base-mainnet" ? "base" : "base-sepolia";
  const jwt = await generateJwt({
    apiKeyId: credentials.apiKeyId,
    apiKeySecret: credentials.apiKeySecret,
    requestMethod: "GET",
    requestHost: "api.cdp.coinbase.com",
    requestPath: "/apikeys/v1/tokens/active",
  });

  const response = await fetch("https://api.cdp.coinbase.com/apikeys/v1/tokens/active", {
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to resolve Base Paymaster URL (${response.status}).`);
  }

  const { id } = (await response.json()) as { id: string };
  return `https://api.cdp.coinbase.com/rpc/v1/${paymasterNetwork}/${id}`;
}

export function loadTestnetEoaBuyer() {
  let key: `0x${string}`;
  if (fs.existsSync(BUYER_KEY_PATH)) {
    key = fs.readFileSync(BUYER_KEY_PATH, "utf8").trim() as `0x${string}`;
  } else {
    key = generatePrivateKey();
    fs.writeFileSync(BUYER_KEY_PATH, key, { encoding: "utf8", mode: 0o600 });
  }
  return privateKeyToAccount(key);
}

export async function createSmartWalletBuyer(networkId: AgentKitNetworkId) {
  const credentials = resolveCdpCredentials();
  const paymasterUrl = await resolveBasePaymasterUrl(credentials, networkId);
  const existing = loadSmartWalletData();

  const walletProvider = await CdpSmartWalletProvider.configureWithWallet({
    apiKeyId: credentials.apiKeyId,
    apiKeySecret: credentials.apiKeySecret,
    walletSecret: credentials.walletSecret,
    networkId,
    rpcUrl: RPC_URLS[networkId],
    paymasterUrl,
    owner: existing?.ownerAddress,
    address: existing?.address,
    smartAccountName: existing?.name,
  });

  const exported = await walletProvider.exportWallet();
  saveSmartWalletData({
    address: walletProvider.getAddress(),
    ownerAddress: exported.ownerAddress,
    name: exported.name,
  });

  console.log(`[buyer] AgentKit smart wallet: ${walletProvider.getAddress()}`);
  console.log(`[buyer] Owner: ${exported.ownerAddress}`);
  console.log(`[buyer] Paymaster: ${walletProvider.getPaymasterUrl() || paymasterUrl}`);

  return walletProvider;
}

async function fundOwnerUsdcFromSmartWallet(
  walletProvider: CdpSmartWalletProvider,
  ownerAddress: `0x${string}`,
  networkId: AgentKitNetworkId,
  amount: bigint,
): Promise<`0x${string}`> {
  const usdc = USDC_BY_NETWORK[networkId];
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [ownerAddress, amount],
  });

  console.log(`[buyer] Funding owner with ${Number(amount) / 1e6} USDC via paymaster-sponsored transfer...`);
  const userOpHash = await walletProvider.sendTransaction({
    to: usdc,
    data,
    value: 0n,
  });
  await walletProvider.waitForTransactionReceipt(userOpHash);
  console.log(`[buyer] Owner funded via user op ${userOpHash}`);
  return userOpHash;
}

export async function createOwnerEoaBuyer(networkId: AgentKitNetworkId, ownerAddress: `0x${string}`) {
  const credentials = resolveCdpCredentials();
  return CdpEvmWalletProvider.configureWithWallet({
    apiKeyId: credentials.apiKeyId,
    apiKeySecret: credentials.apiKeySecret,
    walletSecret: credentials.walletSecret,
    networkId,
    rpcUrl: RPC_URLS[networkId],
    address: ownerAddress,
  });
}

/**
 * Mainnet buyer flow:
 * 1. Load CDP Smart Wallet (paymaster-enabled)
 * 2. Sponsor-gas USDC transfer from smart wallet -> owner EOA
 * 3. Sign x402 payments from the owner EOA (EIP-3009 requires an EOA holder)
 */
export async function createMainnetPaymasterBuyer(minOwnerUsdc = 25_000n) {
  const walletProvider = await createSmartWalletBuyer("base-mainnet");
  const exported = await walletProvider.exportWallet();
  const ownerAddress = exported.ownerAddress as `0x${string}`;
  const publicClient = walletProvider.getPublicClient();
  const smartBalance = await publicClient.readContract({
    address: USDC_BY_NETWORK["base-mainnet"],
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [walletProvider.getAddress() as `0x${string}`],
  });
  let ownerBalance = await publicClient.readContract({
    address: USDC_BY_NETWORK["base-mainnet"],
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [ownerAddress],
  });

  console.log(`[buyer] Smart wallet USDC: ${Number(smartBalance) / 1e6}`);
  console.log(`[buyer] Owner USDC: ${Number(ownerBalance) / 1e6}`);

  if (ownerBalance < minOwnerUsdc) {
    const needed = minOwnerUsdc - ownerBalance;
    if (smartBalance < needed) {
      throw new Error(
        `Insufficient USDC. Smart wallet has ${Number(smartBalance) / 1e6}, owner has ${Number(ownerBalance) / 1e6}.`,
      );
    }
    await fundOwnerUsdcFromSmartWallet(walletProvider, ownerAddress, "base-mainnet", needed);
    for (let i = 0; i < 20; i++) {
      ownerBalance = await publicClient.readContract({
        address: USDC_BY_NETWORK["base-mainnet"],
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [ownerAddress],
      });
      if (ownerBalance >= minOwnerUsdc) {
        console.log(`[buyer] Owner USDC after funding: ${Number(ownerBalance) / 1e6}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const ownerProvider = await createOwnerEoaBuyer("base-mainnet", ownerAddress);
  console.log(`[buyer] x402 signer (owner EOA): ${ownerProvider.getAddress()}`);
  return { smartWalletProvider: walletProvider, ownerProvider };
}

export function toX402Signer(
  walletProvider: {
    getAddress(): string;
    signTypedData(typedData: unknown): Promise<`0x${string}`>;
    getPublicClient(): {
      readContract(args: unknown): Promise<unknown>;
      getTransactionCount(args: { address: `0x${string}` }): Promise<number>;
      estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
    };
  },
): ClientEvmSigner {
  const publicClient = walletProvider.getPublicClient();
  return toClientEvmSigner(
    {
      address: walletProvider.getAddress() as `0x${string}`,
      signTypedData: (typedData) => walletProvider.signTypedData(typedData),
    },
    {
      readContract: (args) => publicClient.readContract(args as never),
      getTransactionCount: (args) => publicClient.getTransactionCount(args),
      estimateFeesPerGas: () => publicClient.estimateFeesPerGas(),
    },
  );
}
