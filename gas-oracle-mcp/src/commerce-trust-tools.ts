import { z } from "zod";

import { CONFIG } from "./config.js";
import {
  issueDeliveryReceipt,
  planFacilitatorFailover,
  screenTokenAllowlist,
  verifyDeliveryReceipt,
} from "./commerce-trust.js";

export const COMMERCE_TRUST_TOOLS = [
  {
    name: "issue_delivery_receipt",
    description:
      `Issue a signed HMAC delivery receipt an agent can store as proof that paid content was delivered. Costs ${CONFIG.prices.issueDeliveryReceipt} USDC per call.`,
    price: CONFIG.prices.issueDeliveryReceipt,
    zodShape: {
      resource: z.string().describe("Paid resource URL or SKU id"),
      buyer: z.string().describe("Buyer 0x address"),
      seller: z.string().describe("Seller 0x address"),
      amountUsd: z.string().describe("Settled amount, e.g. 0.005"),
      network: z.string().optional(),
      content: z.unknown().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        resource: { type: "string" },
        buyer: { type: "string" },
        seller: { type: "string" },
        amountUsd: { type: "string" },
        network: { type: "string" },
        content: {},
      },
      required: ["resource", "buyer", "seller", "amountUsd"],
    },
    example: {
      resource: "https://seller.example/sku/gas",
      buyer: "0x1111111111111111111111111111111111111111",
      seller: "0x2222222222222222222222222222222222222222",
      amountUsd: "0.005",
    },
    handler: async (args: Record<string, unknown>) => issueDeliveryReceipt(args),
  },
  {
    name: "verify_delivery_receipt",
    description:
      `Verify an AgentWire delivery-receipt HMAC. Costs ${CONFIG.prices.verifyDeliveryReceipt} USDC per call.`,
    price: CONFIG.prices.verifyDeliveryReceipt,
    zodShape: {
      receipt: z.record(z.unknown()),
    },
    jsonSchema: {
      type: "object",
      properties: { receipt: { type: "object" } },
      required: ["receipt"],
    },
    handler: async (args: Record<string, unknown>) =>
      verifyDeliveryReceipt(args.receipt as Parameters<typeof verifyDeliveryReceipt>[0]),
  },
  {
    name: "screen_token_allowlist",
    description:
      `Screen a token before an agent pays an x402 invoice. Known USDC on major L2s is allowlisted; unknown tokens return refuse. Costs ${CONFIG.prices.screenTokenAllowlist} USDC per call.`,
    price: CONFIG.prices.screenTokenAllowlist,
    zodShape: {
      token: z.string(),
      chain: z.string().optional(),
      allowlist: z.array(z.string()).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        token: { type: "string" },
        chain: { type: "string" },
        allowlist: { type: "array", items: { type: "string" } },
      },
      required: ["token"],
    },
    example: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain: "base" },
    handler: async (args: Record<string, unknown>) => screenTokenAllowlist(args),
  },
  {
    name: "plan_facilitator_failover",
    description:
      `Probe up to 6 x402 facilitators and return a latency/fee failover order so buyer agents do not stall on a dead facilitator. Costs ${CONFIG.prices.planFacilitatorFailover} USDC per call.`,
    price: CONFIG.prices.planFacilitatorFailover,
    zodShape: {
      facilitators: z
        .array(
          z.object({
            id: z.string().optional(),
            url: z.string(),
            feeBps: z.number().optional(),
          }),
        )
        .max(6)
        .optional(),
      timeoutMs: z.number().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        facilitators: {
          type: "array",
          maxItems: 6,
          items: {
            type: "object",
            properties: { id: { type: "string" }, url: { type: "string" }, feeBps: { type: "number" } },
          },
        },
        timeoutMs: { type: "integer" },
      },
    },
    handler: async (args: Record<string, unknown>) => planFacilitatorFailover(args),
  },
] as const;
