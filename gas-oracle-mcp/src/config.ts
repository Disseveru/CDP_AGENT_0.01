import { config as loadEnv } from "dotenv";

loadEnv();

export type PaymentNetwork = "base-sepolia" | "base";

const NETWORK = (process.env.NETWORK || "base-sepolia") as PaymentNetwork;

if (NETWORK !== "base-sepolia" && NETWORK !== "base") {
  throw new Error(`NETWORK must be "base-sepolia" or "base", got "${NETWORK}"`);
}

/** CAIP-2 chain identifiers used by the x402 v2 protocol. */
const CAIP2: Record<PaymentNetwork, `eip155:${number}`> = {
  "base-sepolia": "eip155:84532",
  base: "eip155:8453",
};

/** AgentKit network IDs differ slightly from x402 network names. */
const AGENTKIT_NETWORK_ID: Record<PaymentNetwork, string> = {
  "base-sepolia": "base-sepolia",
  base: "base-mainnet",
};

const DEFAULT_FACILITATOR: Record<PaymentNetwork, string> = {
  // Free, no-auth facilitator for testnet payments.
  "base-sepolia": "https://x402.org/facilitator",
  // CDP facilitator: settles real USDC and indexes the service in the x402 Bazaar.
  base: "https://api.cdp.coinbase.com/platform/v2/x402",
};

export const CONFIG = {
  network: NETWORK,
  caip2Network: CAIP2[NETWORK],
  agentKitNetworkId: AGENTKIT_NETWORK_ID[NETWORK],
  facilitatorUrl: process.env.FACILITATOR_URL || DEFAULT_FACILITATOR[NETWORK],
  usesCdpFacilitator: !process.env.FACILITATOR_URL && NETWORK === "base",
  port: Number(process.env.PORT || 4021),
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4021}`,
  payToOverride: process.env.PAY_TO_ADDRESS,
  prices: {
    gasSnapshot: process.env.PRICE_GAS_SNAPSHOT || "$0.001",
    recommend: process.env.PRICE_RECOMMEND || "$0.002",
  },
  serviceName: "ChainPulse Gas Oracle",
  serviceVersion: "1.0.0",
} as const;
