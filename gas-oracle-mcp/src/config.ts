import { config as loadEnv } from "dotenv";

loadEnv();

export type PaymentNetwork = "base-sepolia" | "base";

const NETWORK = (process.env.NETWORK || "base") as PaymentNetwork;

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

/** CDP facilitator (recommended for testnet and mainnet). */
export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

/** Signup-free permissionless facilitator fallback when CDP init fails. */
export const DEFAULT_PERMISSIONLESS_FACILITATOR = "https://facilitator.xpay.sh";


function isCdpFacilitatorUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "api.cdp.coinbase.com";
  } catch {
    return false;
  }
}

const facilitatorUrl = process.env.FACILITATOR_URL || CDP_FACILITATOR_URL;

/** PUBLIC_URL override, or Railway's injected domain, or local default. */
function resolvePublicUrl(): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railwayDomain) return `https://${railwayDomain}`;
  return `http://localhost:${process.env.PORT || 4021}`;
}

/** Optional shared secret for Cursor IDE SSE connections (/sse, /messages). */
const mcpApiKey = process.env.MCP_API_KEY?.trim() || undefined;

function resolvePublicBaseUrl(): string {
  return resolvePublicUrl().replace(/\/$/, "");
}

export const CONFIG = {
  network: NETWORK,
  caip2Network: CAIP2[NETWORK],
  agentKitNetworkId: AGENTKIT_NETWORK_ID[NETWORK],
  facilitatorUrl,
  usesCdpFacilitator: isCdpFacilitatorUrl(facilitatorUrl),
  port: Number(process.env.PORT || 4021),
  publicUrl: resolvePublicBaseUrl(),
  /** Absolute POST target for Cursor SSE clients (Railway-safe). */
  sseMessagesEndpoint: `${resolvePublicBaseUrl()}/messages`,
  mcpApiKey,
  payToOverride: process.env.PAY_TO_ADDRESS,
  prices: {
    discovery: process.env.PRICE_DISCOVERY || "$0.001",
    drainInbox: process.env.PRICE_DRAIN_INBOX || "$0.005",
    peekInbox: process.env.PRICE_PEEK_INBOX || "$0.002",
    fetchUrl: process.env.PRICE_FETCH_URL || "$0.012",
  },
  serviceName: "AgentWire",
  serviceVersion: "1.0.0",
} as const;
