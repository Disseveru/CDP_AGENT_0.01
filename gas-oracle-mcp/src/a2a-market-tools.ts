import { z } from "zod";

import { CONFIG } from "./config.js";
import {
  bundleAgentQuote,
  issueDeliveryReceipt,
  pickFacilitatorFailover,
  probeFacilitatorBundle,
  quoteSlaEscrow,
  screenPayee,
  screenToken,
  verifyDeliveryReceipt,
  type DeliveryReceipt,
} from "./a2a-sku.js";
import { analyzeTokenRisk, planOnchainSlaEscrow, pollFacilitatorSettle } from "./a2a-risk-sku.js";

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
    name: "screen_token",
    description: `Allowlist screen for an ERC-20 settlement asset before an agent signs x402. Costs ${CONFIG.prices.screenToken} USDC per call.`,
    price: CONFIG.prices.screenToken,
    zodShape: {
      token: z.string(),
      allowlist: z.array(z.string()).max(50).optional(),
      denylist: z.array(z.string()).max(50).optional(),
      symbolHint: z.string().max(16).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        token: { type: "string" },
        allowlist: { type: "array", items: { type: "string" }, maxItems: 50 },
        denylist: { type: "array", items: { type: "string" }, maxItems: 50 },
        symbolHint: { type: "string" },
      },
      required: ["token"],
    },
    example: {
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      symbolHint: "USDC",
    },
    handler: async (args: Record<string, unknown>) =>
      screenToken({
        token: String(args.token),
        allowlist: args.allowlist as string[] | undefined,
        denylist: args.denylist as string[] | undefined,
        symbolHint: args.symbolHint ? String(args.symbolHint) : undefined,
      }),
  },
  {
    name: "quote_sla_escrow",
    description: `Off-chain SLA hold/penalty quote for A2A work packages. Costs ${CONFIG.prices.quoteSlaEscrow} USDC per call.`,
    price: CONFIG.prices.quoteSlaEscrow,
    zodShape: {
      serviceUsd: z.union([z.number(), z.string()]),
      slaHours: z.number(),
      penaltyBps: z.number().int().optional(),
      holdMultiplier: z.number().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        serviceUsd: { type: ["number", "string"] },
        slaHours: { type: "number" },
        penaltyBps: { type: "integer" },
        holdMultiplier: { type: "number" },
      },
      required: ["serviceUsd", "slaHours"],
    },
    example: { serviceUsd: "1.00", slaHours: 2, penaltyBps: 500 },
    handler: async (args: Record<string, unknown>) =>
      quoteSlaEscrow({
        serviceUsd: args.serviceUsd,
        slaHours: args.slaHours,
        penaltyBps: args.penaltyBps,
        holdMultiplier: args.holdMultiplier,
      }),
  },
  {
    name: "probe_facilitator_bundle",
    description: `Live HTTPS probe of 1-8 facilitators, then pick the first healthy rail. Costs ${CONFIG.prices.probeFacilitatorBundle} USDC per call.`,
    price: CONFIG.prices.probeFacilitatorBundle,
    zodShape: {
      targets: z
        .array(
          z.object({
            name: z.string(),
            url: z.string(),
          }),
        )
        .min(1)
        .max(8),
    },
    jsonSchema: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              url: { type: "string" },
            },
            required: ["name", "url"],
          },
        },
      },
      required: ["targets"],
    },
    example: {
      targets: [
        { name: "cdp", url: "https://api.cdp.coinbase.com/platform/v2/x402" },
        { name: "xpay", url: "https://facilitator.xpay.sh" },
      ],
    },
    handler: async (args: Record<string, unknown>) =>
      probeFacilitatorBundle(args.targets as { name: string; url: string }[]),
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
    name: "analyze_token_risk",
    description: `Static ERC-20 settlement hygiene: spoofed stable names, missing transfer selectors, mint/burn, proxy hints. Costs ${CONFIG.prices.analyzeTokenRisk} USDC per call.`,
    price: CONFIG.prices.analyzeTokenRisk,
    zodShape: {
      token: z.string(),
      symbol: z.string().max(32).optional(),
      decimals: z.number().optional(),
      bytecodeHex: z.string().max(200_000).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        token: { type: "string" },
        symbol: { type: "string" },
        decimals: { type: "number" },
        bytecodeHex: { type: "string" },
      },
      required: ["token"],
    },
    example: {
      token: "0x0000000000000000000000000000000000000001",
      symbol: "USDC",
      decimals: 6,
    },
    handler: async (args: Record<string, unknown>) =>
      analyzeTokenRisk({
        token: String(args.token),
        symbol: args.symbol ? String(args.symbol) : undefined,
        decimals: args.decimals,
        bytecodeHex: args.bytecodeHex ? String(args.bytecodeHex) : undefined,
      }),
  },
  {
    name: "poll_facilitator_settle",
    description: `Idempotent x402 facilitator /settle classifier (V2 pending-vs-terminal). Costs ${CONFIG.prices.pollFacilitatorSettle} USDC per call.`,
    price: CONFIG.prices.pollFacilitatorSettle,
    zodShape: {
      facilitatorUrl: z.string().url(),
      protocol: z.enum(["v1", "v2"]).optional(),
      body: z.record(z.unknown()).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        facilitatorUrl: { type: "string" },
        protocol: { type: "string", enum: ["v1", "v2"] },
        body: { type: "object" },
      },
      required: ["facilitatorUrl"],
    },
    example: {
      facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402/settle",
      protocol: "v2",
    },
    handler: async (args: Record<string, unknown>) =>
      pollFacilitatorSettle({
        facilitatorUrl: String(args.facilitatorUrl),
        protocol: args.protocol === "v1" ? "v1" : "v2",
        body: args.body,
      }),
  },
  {
    name: "plan_onchain_sla_escrow",
    description: `Parameter plan for an A2A SLA hold. Does not deploy a contract. Costs ${CONFIG.prices.planOnchainSlaEscrow} USDC per call.`,
    price: CONFIG.prices.planOnchainSlaEscrow,
    zodShape: {
      buyer: z.string(),
      seller: z.string(),
      token: z.string(),
      serviceUsd: z.union([z.number(), z.string()]),
      slaHours: z.number(),
      penaltyBps: z.number().int().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        buyer: { type: "string" },
        seller: { type: "string" },
        token: { type: "string" },
        serviceUsd: { type: ["number", "string"] },
        slaHours: { type: "number" },
        penaltyBps: { type: "integer" },
      },
      required: ["buyer", "seller", "token", "serviceUsd", "slaHours"],
    },
    example: {
      buyer: "0x0000000000000000000000000000000000000001",
      seller: "0x0000000000000000000000000000000000000002",
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      serviceUsd: "2.00",
      slaHours: 4,
    },
    handler: async (args: Record<string, unknown>) =>
      planOnchainSlaEscrow({
        buyer: String(args.buyer),
        seller: String(args.seller),
        token: String(args.token),
        serviceUsd: args.serviceUsd,
        slaHours: args.slaHours,
        penaltyBps: args.penaltyBps,
      }),
  },
];
