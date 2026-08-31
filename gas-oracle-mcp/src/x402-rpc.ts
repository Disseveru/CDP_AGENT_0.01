import {
  createPublicClient,
  http,
  isAddress,
  type Address,
  type Chain,
  type PublicClient,
} from "viem";
import { arbitrum, base, mainnet, optimism, polygon } from "viem/chains";

import type { GasNetwork } from "./gas.js";

const RPC_TIMEOUT_MS = 12_000;

const CHAIN_BY_NETWORK: Record<GasNetwork, Chain> = {
  base,
  ethereum: mainnet,
  arbitrum,
  optimism,
  polygon,
};

const DEFAULT_RPC: Record<GasNetwork, string> = {
  base: process.env.RPC_BASE || "https://mainnet.base.org",
  ethereum: process.env.RPC_ETHEREUM || "https://ethereum.publicnode.com",
  arbitrum: process.env.RPC_ARBITRUM || "https://arb1.arbitrum.io/rpc",
  optimism: process.env.RPC_OPTIMISM || "https://mainnet.optimism.io",
  polygon: process.env.RPC_POLYGON || "https://polygon-rpc.com",
};

const clientCache = new Map<GasNetwork, PublicClient>();

export function resolveCommerceNetwork(raw: unknown): GasNetwork {
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

export function parseCommerceAddress(raw: unknown, label = "address"): Address {
  const value = String(raw || "").trim();
  if (!isAddress(value)) {
    throw new Error(`Invalid ${label}: "${raw}"`);
  }
  return value as Address;
}

export function getCommerceClient(network: GasNetwork): PublicClient {
  const cached = clientCache.get(network);
  if (cached) return cached;
  const client = createPublicClient({
    chain: CHAIN_BY_NETWORK[network],
    transport: http(DEFAULT_RPC[network], {
      timeout: RPC_TIMEOUT_MS,
      retryCount: 1,
      retryDelay: 250,
    }),
  });
  clientCache.set(network, client);
  return client;
}
