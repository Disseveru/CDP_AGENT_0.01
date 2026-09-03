import { z } from "zod";

import { CONFIG } from "./config.js";
import { getGasOracle, getGasOracleBatch, estimateTxCost } from "./gas-oracle.js";
import { getBalance, getTxStatus } from "./gas.js";
import { planAgentSpend, verifySettlementTx, cheapestChainForTx } from "./agent-commerce.js";
import { probeX402Endpoint, rankX402Endpoints } from "./x402-probe.js";
import { normalizeX402Receipt } from "./x402-receipt.js";

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
    name: "probe_x402",
    description: `Probe a URL for live x402 payment terms before spending. Returns 402 status, parsed accepts, cheapest USD price, payTo, and buy/skip advice. Costs ${CONFIG.prices.probeX402} USDC per call.`,
    price: CONFIG.prices.probeX402,
    zodShape: {
      url: z.string().url(),
      method: z.enum(["GET", "POST", "HEAD"]).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        method: { type: "string", enum: ["GET", "POST", "HEAD"] },
      },
      required: ["url"],
    },
    example: { url: "https://agentic.market/", method: "GET" },
    handler: async (args) => probeX402Endpoint({ url: args.url, method: args.method }),
  },
  {
    name: "rank_x402_endpoints",
    description: `Probe up to 5 x402 URLs and rank live sellers by cheapest advertised USDC price. Costs ${CONFIG.prices.rankX402} USDC per call.`,
    price: CONFIG.prices.rankX402,
    zodShape: {
      urls: z.array(z.string().url()).min(1).max(5),
      method: z.enum(["GET", "POST", "HEAD"]).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string", format: "uri" }, minItems: 1, maxItems: 5 },
        method: { type: "string", enum: ["GET", "POST", "HEAD"] },
      },
      required: ["urls"],
    },
    example: { urls: ["https://agentic.market/", "https://x402.org/"] },
    handler: async (args) => rankX402Endpoints({ urls: args.urls, method: args.method }),
  },
  {
    name: "normalize_x402_receipt",
    description: `Turn PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE headers into a structured receipt another agent can verify. Costs ${CONFIG.prices.normalizeReceipt} USDC per call.`,
    price: CONFIG.prices.normalizeReceipt,
    zodShape: {
      paymentRequiredHeader: z.unknown().optional(),
      paymentSignatureHeader: z.unknown().optional(),
      paymentResponseHeader: z.unknown().optional(),
      txHash: z.string().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        paymentRequiredHeader: {},
        paymentSignatureHeader: {},
        paymentResponseHeader: {},
        txHash: { type: "string" },
      },
    },
    example: {
      paymentRequiredHeader: { x402Version: 2, accepts: [{ scheme: "exact", maxAmountRequired: "5000" }] },
      txHash: "0xabc",
    },
    handler: async (args) => normalizeX402Receipt(args),
  },
  {
    name: "commerce_preflight",
    description: `Bundle: probe an x402 URL and plan how many calls a USDC balance can buy at the advertised price. Costs ${CONFIG.prices.commercePreflight} USDC per call.`,
    price: CONFIG.prices.commercePreflight,
    zodShape: {
      url: z.string().url(),
      balanceUsd: z.union([z.number(), z.string()]),
      reserveUsd: z.union([z.number(), z.string()]).optional(),
      maxCalls: z.number().int().optional(),
      method: z.enum(["GET", "POST", "HEAD"]).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        balanceUsd: { type: ["number", "string"] },
        reserveUsd: { type: ["number", "string"] },
        maxCalls: { type: "integer" },
        method: { type: "string", enum: ["GET", "POST", "HEAD"] },
      },
      required: ["url", "balanceUsd"],
    },
    example: { url: "https://agentic.market/", balanceUsd: "1.00", reserveUsd: "0.10" },
    handler: async (args) => {
      const probe = await probeX402Endpoint({ url: args.url, method: args.method });
      const pricePerCallUsd = probe.cheapestUsd ?? 0;
      const plan =
        pricePerCallUsd > 0
          ? planAgentSpend({
              balanceUsd: args.balanceUsd,
              pricePerCallUsd,
              reserveUsd: args.reserveUsd,
              maxCalls: args.maxCalls,
            })
          : null;
      return {
        probe,
        plan,
        recommendation:
          plan?.recommendation ??
          (probe.paymentRequired
            ? "Terms found but price could not be parsed — inspect probe.accepts before buying."
            : probe.recommendation),
      };
    },
  },
];
