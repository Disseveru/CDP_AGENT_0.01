import { z } from "zod";

import { CONFIG } from "./config.js";
import { getGasOracle, getGasOracleBatch, estimateTxCost } from "./gas-oracle.js";
import { getBalance, getTxStatus } from "./gas.js";
import { planAgentSpend, verifySettlementTx, cheapestChainForTx } from "./agent-commerce.js";
import {
  probeX402Endpoint,
  rankAgenticSellers,
  inspectPayTo,
  getUsdcInventory,
  adviseCongestion,
} from "./marketplace-commerce.js";

export interface ExtraPaidToolDefinition {
  name: string;
  description: string;
  price: string;
  zodShape: Record<string, z.ZodTypeAny>;
  jsonSchema: Record<string, unknown>;
  example?: Record<string, unknown>;
  outputExample?: unknown;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export const EXTRA_PAID_TOOLS: ExtraPaidToolDefinition[] = [
  {
    name: "quote_gas",
    description:
      `Live EIP-1559 gas oracle for autonomous agents. Returns base fee, slow/standard/fast maxFee suggestions, native USD price, and cost estimates. Costs ${CONFIG.prices.gasOracle} USDC per call.`,
    price: CONFIG.prices.gasOracle,
    zodShape: {
      chain: z.string().describe("Chain id: ethereum | base | arbitrum | optimism | polygon | base-sepolia"),
    },
    jsonSchema: {
      type: "object",
      properties: {
        chain: {
          type: "string",
          enum: ["ethereum", "base", "arbitrum", "optimism", "polygon", "base-sepolia"],
        },
      },
      required: ["chain"],
    },
    example: { chain: "base" },
    handler: async (args) => getGasOracle(args.chain),
  },
  {
    name: "quote_gas_bundle",
    description: `Batch gas quotes across up to 6 chains. Costs ${CONFIG.prices.gasOracleBundle} USDC per call.`,
    price: CONFIG.prices.gasOracleBundle,
    zodShape: {
      chains: z.array(z.string()).max(6).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: { chains: { type: "array", items: { type: "string" }, maxItems: 6 } },
    },
    example: { chains: ["base", "ethereum", "arbitrum"] },
    handler: async (args) => getGasOracleBatch(args.chains),
  },
  {
    name: "estimate_tx_cost",
    description: `USD cost for a custom gasLimit. Costs ${CONFIG.prices.estimateTxCost} USDC per call.`,
    price: CONFIG.prices.estimateTxCost,
    zodShape: {
      chain: z.string(),
      gasLimit: z.union([z.number(), z.string()]),
    },
    jsonSchema: {
      type: "object",
      properties: { chain: { type: "string" }, gasLimit: { type: ["integer", "string"] } },
      required: ["chain", "gasLimit"],
    },
    example: { chain: "base", gasLimit: 180000 },
    handler: async (args) => estimateTxCost({ chain: args.chain, gasLimit: args.gasLimit }),
  },
  {
    name: "get_balance",
    description: `Native or ERC-20 balance. Costs ${CONFIG.prices.getBalance} USDC per call.`,
    price: CONFIG.prices.getBalance,
    zodShape: {
      address: z.string(),
      network: z.string().optional(),
      token: z.string().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: { address: { type: "string" }, network: { type: "string" }, token: { type: "string" } },
      required: ["address"],
    },
    example: { address: "0x0000000000000000000000000000000000000000", network: "base" },
    handler: async (args) =>
      getBalance({
        address: String(args.address),
        network: args.network as string | undefined,
        token: args.token as string | undefined,
      }),
  },
  {
    name: "get_tx_status",
    description: `Tx pending/success/reverted/not_found. Costs ${CONFIG.prices.getTxStatus} USDC per call.`,
    price: CONFIG.prices.getTxStatus,
    zodShape: {
      hash: z.string(),
      network: z.string().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: { hash: { type: "string" }, network: { type: "string" } },
      required: ["hash"],
    },
    example: {
      hash: "0x0000000000000000000000000000000000000000000000000000000000000001",
      network: "base",
    },
    handler: async (args) =>
      getTxStatus({ hash: String(args.hash), network: args.network as string | undefined }),
  },
  {
    name: "plan_agent_spend",
    description: `How many paid calls a USDC balance can buy. Costs ${CONFIG.prices.planAgentSpend} USDC per call.`,
    price: CONFIG.prices.planAgentSpend,
    zodShape: {
      balanceUsd: z.union([z.number(), z.string()]),
      pricePerCallUsd: z.union([z.number(), z.string()]),
      reserveUsd: z.union([z.number(), z.string()]).optional(),
      maxCalls: z.number().int().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        balanceUsd: { type: ["number", "string"] },
        pricePerCallUsd: { type: ["number", "string"] },
        reserveUsd: { type: ["number", "string"] },
        maxCalls: { type: "integer" },
      },
      required: ["balanceUsd", "pricePerCallUsd"],
    },
    example: { balanceUsd: "1.00", pricePerCallUsd: "$0.005", reserveUsd: "0.10", maxCalls: 50 },
    handler: async (args) => planAgentSpend(args),
  },
  {
    name: "verify_settlement",
    description: `Confirm a settlement hash landed and optional payTo match. Costs ${CONFIG.prices.verifySettlement} USDC per call.`,
    price: CONFIG.prices.verifySettlement,
    zodShape: {
      hash: z.string(),
      network: z.string().optional(),
      expectedTo: z.string().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: { hash: { type: "string" }, network: { type: "string" }, expectedTo: { type: "string" } },
      required: ["hash"],
    },
    example: {
      hash: "0x0000000000000000000000000000000000000000000000000000000000000001",
      network: "base",
    },
    handler: async (args) =>
      verifySettlementTx({
        hash: String(args.hash),
        network: args.network as string | undefined,
        expectedTo: args.expectedTo as string | undefined,
      }),
  },
  {
    name: "cheapest_chain",
    description: `Rank chains by USD cost for a gasLimit. Costs ${CONFIG.prices.cheapestChain} USDC per call.`,
    price: CONFIG.prices.cheapestChain,
    zodShape: {
      gasLimit: z.union([z.number(), z.string()]).optional(),
      chains: z.array(z.string()).max(6).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        gasLimit: { type: ["integer", "string"] },
        chains: { type: "array", items: { type: "string" }, maxItems: 6 },
      },
    },
    example: { gasLimit: 250000, chains: ["base", "arbitrum", "optimism"] },
    handler: async (args) => cheapestChainForTx({ gasLimit: args.gasLimit, chains: args.chains }),
  },
  {
    name: "probe_x402_endpoint",
    description: `Unpaid probe of a public URL. Returns HTTP status, PAYMENT-REQUIRED header decode, and whether the seller looks live. Costs ${CONFIG.prices.probeX402} USDC per call.`,
    price: CONFIG.prices.probeX402,
    zodShape: {
      url: z.string(),
      method: z.string().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: { url: { type: "string" }, method: { type: "string", enum: ["GET", "HEAD", "POST"] } },
      required: ["url"],
    },
    example: { url: "https://api.exa.ai/search", method: "POST" },
    handler: async (args) => probeX402Endpoint({ url: args.url, method: args.method }),
  },
  {
    name: "rank_agentic_sellers",
    description: `Search Agentic.Market and rank live x402 sellers by price and 30-day volume. Costs ${CONFIG.prices.rankSellers} USDC per call.`,
    price: CONFIG.prices.rankSellers,
    zodShape: {
      query: z.string(),
      limit: z.number().int().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer" } },
      required: ["query"],
    },
    example: { query: "web search", limit: 8 },
    handler: async (args) => rankAgenticSellers({ query: args.query, limit: args.limit }),
  },
  {
    name: "inspect_payto",
    description: `Check a merchant payTo address: USDC + native balances on one chain before first payment. Costs ${CONFIG.prices.inspectPayTo} USDC per call.`,
    price: CONFIG.prices.inspectPayTo,
    zodShape: {
      address: z.string(),
      network: z.string().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: { address: { type: "string" }, network: { type: "string" } },
      required: ["address"],
    },
    example: { address: "0x0000000000000000000000000000000000000001", network: "base" },
    handler: async (args) => inspectPayTo({ address: args.address, network: args.network }),
  },
  {
    name: "usdc_inventory",
    description: `Multi-chain USDC + native snapshot for a buyer or seller wallet. Costs ${CONFIG.prices.usdcInventory} USDC per call.`,
    price: CONFIG.prices.usdcInventory,
    zodShape: {
      address: z.string(),
      networks: z.array(z.string()).max(5).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: { address: { type: "string" }, networks: { type: "array", items: { type: "string" }, maxItems: 5 } },
      required: ["address"],
    },
    example: { address: "0x0000000000000000000000000000000000000001", networks: ["base", "ethereum"] },
    handler: async (args) => getUsdcInventory({ address: args.address, networks: args.networks }),
  },
  {
    name: "advise_congestion",
    description: `Tell an agent whether to submit now or wait based on live gas. Costs ${CONFIG.prices.congestionAdvice} USDC per call.`,
    price: CONFIG.prices.congestionAdvice,
    zodShape: {
      network: z.string().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: { network: { type: "string" } },
    },
    example: { network: "base" },
    handler: async (args) => adviseCongestion({ network: args.network }),
  },
];
