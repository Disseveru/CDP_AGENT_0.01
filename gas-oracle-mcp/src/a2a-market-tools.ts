import { z } from "zod";

import { CONFIG } from "./config.js";
import {
  bundleAgentQuote,
  issueDeliveryReceipt,
  pickFacilitatorFailover,
  screenPayee,
  verifyDeliveryReceipt,
  type DeliveryReceipt,
} from "./a2a-sku.js";
import {
  normalizeX402Amount,
  screenSettlementAsset,
  settlementReadiness,
} from "./settlement-asset.js";

export const A2A_MARKET_TOOLS = [
  {
    name: "screen_payee",
    description: `Allowlist/denylist + price-cap screen for an x402 payTo before the buyer agent signs. Costs ${CONFIG.prices.screenPayee} USDC per call.`,
    price: CONFIG.prices.screenPayee,
    zodShape: {
      payTo: z.string(),
      allowlist: z.array(z.string()).max(50).optional(),
      denylist: z.array(z.string()).max(50).optional(),
      listedPriceUsd: z.union([z.number(), z.string()]).optional(),
      maxPriceUsd: z.union([z.number(), z.string()]).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        payTo: { type: "string" },
        allowlist: { type: "array", items: { type: "string" }, maxItems: 50 },
        denylist: { type: "array", items: { type: "string" }, maxItems: 50 },
        listedPriceUsd: { type: ["number", "string"] },
        maxPriceUsd: { type: ["number", "string"] },
      },
      required: ["payTo"],
    },
    example: {
      payTo: "0x0000000000000000000000000000000000000001",
      listedPriceUsd: "0.01",
      maxPriceUsd: "0.05",
    },
    handler: async (args: Record<string, unknown>) =>
      screenPayee({
        payTo: String(args.payTo),
        allowlist: args.allowlist as string[] | undefined,
        denylist: args.denylist as string[] | undefined,
        listedPriceUsd: args.listedPriceUsd,
        maxPriceUsd: args.maxPriceUsd,
      }),
  },
  {
    name: "bundle_agent_quote",
    description: `Price a 1-20 SKU bundle for one agent shopping session. Costs ${CONFIG.prices.bundleAgentQuote} USDC per call.`,
    price: CONFIG.prices.bundleAgentQuote,
    zodShape: {
      lines: z
        .array(
          z.object({
            sku: z.string(),
            priceUsd: z.union([z.number(), z.string()]),
            qty: z.number().int().optional(),
          }),
        )
        .min(1)
        .max(20),
      discountUsd: z.union([z.number(), z.string()]).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        lines: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              sku: { type: "string" },
              priceUsd: { type: ["number", "string"] },
              qty: { type: "integer" },
            },
            required: ["sku", "priceUsd"],
          },
        },
        discountUsd: { type: ["number", "string"] },
      },
      required: ["lines"],
    },
    example: {
      lines: [
        { sku: "quote_gas", priceUsd: "0.002", qty: 10 },
        { sku: "verify_settlement", priceUsd: "$0.003", qty: 2 },
      ],
      discountUsd: "0.004",
    },
    handler: async (args: Record<string, unknown>) =>
      bundleAgentQuote(args.lines as never, args.discountUsd),
  },
  {
    name: "issue_delivery_receipt",
    description: `HMAC-SHA256 signed proof that a paid SKU was delivered (content hash). Costs ${CONFIG.prices.issueDeliveryReceipt} USDC per call.`,
    price: CONFIG.prices.issueDeliveryReceipt,
    zodShape: {
      sku: z.string(),
      buyer: z.string(),
      seller: z.string(),
      amountUsd: z.union([z.number(), z.string()]),
      contentHash: z.string().min(16).max(128),
    },
    jsonSchema: {
      type: "object",
      properties: {
        sku: { type: "string" },
        buyer: { type: "string" },
        seller: { type: "string" },
        amountUsd: { type: ["number", "string"] },
        contentHash: { type: "string", minLength: 16, maxLength: 128 },
      },
      required: ["sku", "buyer", "seller", "amountUsd", "contentHash"],
    },
    example: {
      sku: "fetch_url",
      buyer: "0xbuyer",
      seller: "0xseller",
      amountUsd: "0.012",
      contentHash: "abc123def4567890",
    },
    handler: async (args: Record<string, unknown>) =>
      issueDeliveryReceipt({
        sku: String(args.sku),
        buyer: String(args.buyer),
        seller: String(args.seller),
        amountUsd: args.amountUsd,
        contentHash: String(args.contentHash),
      }),
  },
  {
    name: "verify_delivery_receipt",
    description: `Verify an AgentWire HMAC delivery receipt. Costs ${CONFIG.prices.verifyDeliveryReceipt} USDC per call.`,
    price: CONFIG.prices.verifyDeliveryReceipt,
    zodShape: {
      receipt: z.object({
        receiptId: z.string(),
        sku: z.string(),
        buyer: z.string(),
        seller: z.string(),
        amountUsd: z.string(),
        contentHash: z.string(),
        issuedAt: z.string(),
        signature: z.string(),
      }),
    },
    jsonSchema: {
      type: "object",
      properties: {
        receipt: {
          type: "object",
          properties: {
            receiptId: { type: "string" },
            sku: { type: "string" },
            buyer: { type: "string" },
            seller: { type: "string" },
            amountUsd: { type: "string" },
            contentHash: { type: "string" },
            issuedAt: { type: "string" },
            signature: { type: "string" },
          },
          required: ["receiptId", "sku", "buyer", "seller", "amountUsd", "contentHash", "issuedAt", "signature"],
        },
      },
      required: ["receipt"],
    },
    handler: async (args: Record<string, unknown>) =>
      verifyDeliveryReceipt(args.receipt as DeliveryReceipt),
  },
  {
    name: "facilitator_failover",
    description: `Pick the first healthy low-latency facilitator from a probe list. Costs ${CONFIG.prices.facilitatorFailover} USDC per call.`,
    price: CONFIG.prices.facilitatorFailover,
    zodShape: {
      candidates: z
        .array(
          z.object({
            name: z.string(),
            url: z.string(),
            ok: z.boolean(),
            latencyMs: z.number().nullable(),
            error: z.string().optional(),
          }),
        )
        .min(1)
        .max(12),
    },
    jsonSchema: {
      type: "object",
      properties: {
        candidates: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              url: { type: "string" },
              ok: { type: "boolean" },
              latencyMs: { type: ["number", "null"] },
              error: { type: "string" },
            },
            required: ["name", "url", "ok", "latencyMs"],
          },
        },
      },
      required: ["candidates"],
    },
    example: {
      candidates: [
        { name: "cdp", url: "https://api.cdp.coinbase.com/platform/v2/x402", ok: true, latencyMs: 80 },
        { name: "xpay", url: "https://facilitator.xpay.sh", ok: false, latencyMs: null },
      ],
    },
    handler: async (args: Record<string, unknown>) => pickFacilitatorFailover(args.candidates as never),
  },
  {
    name: "screen_settlement_asset",
    description: `Allowlist native Circle USDC contracts so agents refuse unknown/fee-on-transfer ERC-20s in a 402 challenge. Costs ${CONFIG.prices.screenSettlementAsset} USDC per call.`,
    price: CONFIG.prices.screenSettlementAsset,
    zodShape: {
      asset: z.string(),
      network: z.string().optional(),
      caip2: z.string().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        asset: { type: "string" },
        network: { type: "string" },
        caip2: { type: "string" },
      },
      required: ["asset"],
    },
    example: { asset: "USDC", network: "base" },
    handler: async (args: Record<string, unknown>) =>
      screenSettlementAsset({
        asset: String(args.asset),
        network: args.network as string | undefined,
        caip2: args.caip2 as string | undefined,
      }),
  },
  {
    name: "normalize_x402_amount",
    description: `Convert human USD to 402 maxAmountRequired atomic units (default 6 decimals) or decode atomic back to USD. Costs ${CONFIG.prices.normalizeX402Amount} USDC per call.`,
    price: CONFIG.prices.normalizeX402Amount,
    zodShape: {
      amountUsd: z.union([z.number(), z.string()]).optional(),
      atomic: z.string().optional(),
      decimals: z.number().int().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        amountUsd: { type: ["number", "string"] },
        atomic: { type: "string" },
        decimals: { type: "integer" },
      },
    },
    example: { amountUsd: "0.002" },
    handler: async (args: Record<string, unknown>) =>
      normalizeX402Amount({
        amountUsd: args.amountUsd,
        atomic: args.atomic as string | undefined,
        decimals: args.decimals as number | undefined,
      }),
  },
  {
    name: "settlement_readiness",
    description: `Bundle: USDC asset allowlist + atomic amount + payee screen before the agent signs. Costs ${CONFIG.prices.settlementReadiness} USDC per call.`,
    price: CONFIG.prices.settlementReadiness,
    zodShape: {
      payTo: z.string(),
      asset: z.string(),
      amountUsd: z.union([z.number(), z.string()]).optional(),
      atomic: z.string().optional(),
      network: z.string().optional(),
      caip2: z.string().optional(),
      allowlist: z.array(z.string()).max(50).optional(),
      denylist: z.array(z.string()).max(50).optional(),
      maxPriceUsd: z.union([z.number(), z.string()]).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        payTo: { type: "string" },
        asset: { type: "string" },
        amountUsd: { type: ["number", "string"] },
        atomic: { type: "string" },
        network: { type: "string" },
        caip2: { type: "string" },
        allowlist: { type: "array", items: { type: "string" }, maxItems: 50 },
        denylist: { type: "array", items: { type: "string" }, maxItems: 50 },
        maxPriceUsd: { type: ["number", "string"] },
      },
      required: ["payTo", "asset"],
    },
    example: {
      payTo: "0x0000000000000000000000000000000000000002",
      asset: "USDC",
      network: "base",
      amountUsd: "0.01",
      maxPriceUsd: "0.05",
    },
    handler: async (args: Record<string, unknown>) =>
      settlementReadiness({
        payTo: String(args.payTo),
        asset: String(args.asset),
        amountUsd: args.amountUsd,
        atomic: args.atomic as string | undefined,
        network: args.network as string | undefined,
        caip2: args.caip2 as string | undefined,
        allowlist: args.allowlist as string[] | undefined,
        denylist: args.denylist as string[] | undefined,
        maxPriceUsd: args.maxPriceUsd,
      }),
  },
];
