import { z } from "zod";

import { CONFIG } from "./config.js";
import { getGasOracle, getGasOracleBatch, estimateTxCost } from "./gas-oracle.js";
import { getBalance, getTxStatus } from "./gas.js";
import { planAgentSpend, verifySettlementTx, cheapestChainForTx } from "./agent-commerce.js";
import { X402_MARKET_TOOLS } from "./x402-market-tools.js";
import { searchAgenticMarket, checkFacilitatorHealth } from "./agentic-discovery.js";
import { preflightPaySession, scoreX402Seller } from "./commerce-preflight.js";
import {
  a2aCommerceBundle,
  issueDeliveryReceipt,
  pickFacilitatorFailover,
  screenTokenAllowlist,
} from "./a2a-commerce-skus.js";

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
    name: "search_agentic_market",
    description: `Search Agentic.Market x402 listings by keyword. Returns name, category, networks, and min USDC price. Costs ${CONFIG.prices.searchAgenticMarket} USDC per call.`,
    price: CONFIG.prices.searchAgenticMarket,
    zodShape: {
      q: z.string().min(1).max(80),
      limit: z.number().int().min(1).max(25).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        q: { type: "string", minLength: 1, maxLength: 80 },
        limit: { type: "integer", minimum: 1, maximum: 25 },
      },
      required: ["q"],
    },
    example: { q: "search", limit: 8 },
    handler: async (args) => searchAgenticMarket({ q: String(args.q), limit: args.limit as number | undefined }),
  },
  {
    name: "facilitator_health",
    description: `Probe known x402 facilitators for HTTP liveness and latency. Costs ${CONFIG.prices.facilitatorHealth} USDC per call.`,
    price: CONFIG.prices.facilitatorHealth,
    zodShape: {},
    jsonSchema: { type: "object", properties: {} },
    example: {},
    handler: async () => checkFacilitatorHealth(),
  },
  {
    name: "score_x402_seller",
    description: `Risk-score an x402 402 challenge (payTo, scheme, network, price). Costs ${CONFIG.prices.scoreX402Seller} USDC per call.`,
    price: CONFIG.prices.scoreX402Seller,
    zodShape: {
      payload: z.unknown(),
      httpStatus: z.number().int().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: { payload: {}, httpStatus: { type: "integer" } },
      required: ["payload"],
    },
    example: {
      httpStatus: 402,
      payload: {
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            asset: "USDC",
            payTo: "0x0000000000000000000000000000000000000001",
            maxAmountRequired: "2000",
          },
        ],
      },
    },
    handler: async (args) => scoreX402Seller(args.payload, args.httpStatus as number | undefined),
  },
  {
    name: "preflight_pay_session",
    description: `Bundle: score seller + plan spend from USDC balance against the cheapest listed price. Costs ${CONFIG.prices.preflightPaySession} USDC per call.`,
    price: CONFIG.prices.preflightPaySession,
    zodShape: {
      balanceUsd: z.union([z.number(), z.string()]),
      payload: z.unknown(),
      httpStatus: z.number().int().optional(),
      reserveUsd: z.union([z.number(), z.string()]).optional(),
      maxCalls: z.number().int().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        balanceUsd: { type: ["number", "string"] },
        payload: {},
        httpStatus: { type: "integer" },
        reserveUsd: { type: ["number", "string"] },
        maxCalls: { type: "integer" },
      },
      required: ["balanceUsd", "payload"],
    },
    example: {
      balanceUsd: "1.00",
      reserveUsd: "0.10",
      httpStatus: 402,
      payload: {
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            asset: "USDC",
            payTo: "0x0000000000000000000000000000000000000001",
            maxAmountRequired: "2000",
          },
        ],
      },
    },
    handler: async (args) => preflightPaySession(args),
  },
  {
    name: "screen_token_allowlist",
    description: `Allowlist-screen an x402 asset + payTo before an agent spends. Costs ${CONFIG.prices.screenTokenAllowlist} USDC per call.`,
    price: CONFIG.prices.screenTokenAllowlist,
    zodShape: {
      asset: z.string(),
      network: z.string(),
      payTo: z.string().optional(),
      extraAllowlist: z.array(z.string()).max(20).optional(),
      extraDenylist: z.array(z.string()).max(20).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        asset: { type: "string" },
        network: { type: "string" },
        payTo: { type: "string" },
        extraAllowlist: { type: "array", items: { type: "string" }, maxItems: 20 },
        extraDenylist: { type: "array", items: { type: "string" }, maxItems: 20 },
      },
      required: ["asset", "network"],
    },
    example: {
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      network: "eip155:8453",
      payTo: "0x0000000000000000000000000000000000000001",
    },
    handler: async (args) => screenTokenAllowlist(args as never),
  },
  {
    name: "pick_facilitator_failover",
    description: `Rank live x402 facilitators by latency and return the fail-over pick. Costs ${CONFIG.prices.pickFacilitatorFailover} USDC per call.`,
    price: CONFIG.prices.pickFacilitatorFailover,
    zodShape: {
      urls: z.array(z.object({ id: z.string().optional(), url: z.string().url() })).max(8).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            properties: { id: { type: "string" }, url: { type: "string", format: "uri" } },
            required: ["url"],
          },
        },
      },
    },
    example: {},
    handler: async (args) => pickFacilitatorFailover({ urls: args.urls as never }),
  },
  {
    name: "issue_delivery_receipt",
    description: `HMAC-SHA256 delivery receipt for a paid SKU payload. Costs ${CONFIG.prices.issueDeliveryReceipt} USDC per call.`,
    price: CONFIG.prices.issueDeliveryReceipt,
    zodShape: {
      sku: z.string().min(1),
      payload: z.unknown(),
      buyer: z.string().optional(),
      seller: z.string().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        sku: { type: "string" },
        payload: {},
        buyer: { type: "string" },
        seller: { type: "string" },
      },
      required: ["sku"],
    },
    example: { sku: "quote_gas", payload: { chain: "base" }, buyer: "0xabc", seller: "agentwire" },
    handler: async (args) => issueDeliveryReceipt(args as never),
  },
  {
    name: "a2a_commerce_bundle",
    description: `Bundled allowlist screen + facilitator failover + signed receipt. Costs ${CONFIG.prices.a2aCommerceBundle} USDC per call.`,
    price: CONFIG.prices.a2aCommerceBundle,
    zodShape: {
      asset: z.string(),
      network: z.string(),
      payTo: z.string().optional(),
      sku: z.string().min(1),
      payload: z.unknown(),
      buyer: z.string().optional(),
      seller: z.string().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        asset: { type: "string" },
        network: { type: "string" },
        payTo: { type: "string" },
        sku: { type: "string" },
        payload: {},
        buyer: { type: "string" },
        seller: { type: "string" },
      },
      required: ["asset", "network", "sku"],
    },
    example: {
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      network: "base",
      sku: "quote_gas",
      payload: { chain: "base" },
    },
    handler: async (args) => a2aCommerceBundle(args as never),
  },
  ...X402_MARKET_TOOLS,
];
