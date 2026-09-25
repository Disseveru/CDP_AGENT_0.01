import { z } from "zod";

import { CONFIG } from "./config.js";
import {
  consumeSpendSession,
  issueSpendSession,
  quoteReceiptSlaPack,
  sellerHostDossier,
  validateSellerPayload,
  type SpendSession,
} from "./a2a-commerce-pack.js";

export const A2A_COMMERCE_PACK_TOOLS = [
  {
    name: "issue_spend_session",
    description: `HMAC child-agent spend cap (upto-style budget). Costs ${CONFIG.prices.issueSpendSession} USDC per call.`,
    price: CONFIG.prices.issueSpendSession,
    zodShape: {
      parentAgent: z.string(),
      budgetUsd: z.union([z.number(), z.string()]),
      ttlSeconds: z.number().int().optional(),
      allowSkus: z.array(z.string()).max(40).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        parentAgent: { type: "string" },
        budgetUsd: { type: ["number", "string"] },
        ttlSeconds: { type: "integer" },
        allowSkus: { type: "array", items: { type: "string" }, maxItems: 40 },
      },
      required: ["parentAgent", "budgetUsd"],
    },
    example: {
      parentAgent: "orchestrator-1",
      budgetUsd: "0.50",
      ttlSeconds: 3600,
      allowSkus: ["quote_gas", "verify_settlement"],
    },
    handler: async (args: Record<string, unknown>) =>
      issueSpendSession({
        parentAgent: String(args.parentAgent),
        budgetUsd: args.budgetUsd,
        ttlSeconds: args.ttlSeconds,
        allowSkus: args.allowSkus as string[] | undefined,
      }),
  },
  {
    name: "consume_spend_session",
    description: `Debit a signed child-agent spend session. Costs ${CONFIG.prices.consumeSpendSession} USDC per call.`,
    price: CONFIG.prices.consumeSpendSession,
    zodShape: {
      session: z.object({
        sessionId: z.string(),
        parentAgent: z.string(),
        budgetUsd: z.string(),
        spentUsd: z.string(),
        remainingUsd: z.string(),
        allowSkus: z.array(z.string()),
        expiresAt: z.string(),
        signature: z.string(),
      }),
      sku: z.string(),
      amountUsd: z.union([z.number(), z.string()]),
    },
    jsonSchema: {
      type: "object",
      properties: {
        session: { type: "object" },
        sku: { type: "string" },
        amountUsd: { type: ["number", "string"] },
      },
      required: ["session", "sku", "amountUsd"],
    },
    handler: async (args: Record<string, unknown>) =>
      consumeSpendSession({
        session: args.session as SpendSession,
        sku: String(args.sku),
        amountUsd: args.amountUsd,
      }),
  },
  {
    name: "seller_host_dossier",
    description: `Score an Agentic.Market / Bazaar host from 30d calls, unique payers, scheme, and hygiene. Costs ${CONFIG.prices.sellerHostDossier} USDC per call.`,
    price: CONFIG.prices.sellerHostDossier,
    zodShape: {
      host: z.string(),
      l30DaysTotalCalls: z.union([z.number(), z.string()]).optional(),
      l30DaysUniquePayers: z.union([z.number(), z.string()]).optional(),
      listedPriceUsd: z.union([z.number(), z.string()]).optional(),
      scheme: z.string().optional(),
      isNew: z.boolean().optional(),
      headerHygieneOk: z.boolean().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        l30DaysTotalCalls: { type: ["number", "string"] },
        l30DaysUniquePayers: { type: ["number", "string"] },
        listedPriceUsd: { type: ["number", "string"] },
        scheme: { type: "string" },
        isNew: { type: "boolean" },
        headerHygieneOk: { type: "boolean" },
      },
      required: ["host"],
    },
    example: {
      host: "api.exa.ai",
      l30DaysTotalCalls: 6082,
      l30DaysUniquePayers: 88,
      listedPriceUsd: "0.007",
      scheme: "exact",
      headerHygieneOk: true,
    },
    handler: async (args: Record<string, unknown>) =>
      sellerHostDossier({
        host: String(args.host),
        l30DaysTotalCalls: args.l30DaysTotalCalls,
        l30DaysUniquePayers: args.l30DaysUniquePayers,
        listedPriceUsd: args.listedPriceUsd,
        scheme: args.scheme ? String(args.scheme) : undefined,
        isNew: args.isNew as boolean | undefined,
        headerHygieneOk: args.headerHygieneOk as boolean | undefined,
      }),
  },
  {
    name: "quote_receipt_sla_pack",
    description: `Single hop: signed delivery receipt + self-verify + SLA hold quote. Costs ${CONFIG.prices.quoteReceiptSlaPack} USDC per call.`,
    price: CONFIG.prices.quoteReceiptSlaPack,
    zodShape: {
      sku: z.string(),
      buyer: z.string(),
      seller: z.string(),
      amountUsd: z.union([z.number(), z.string()]),
      contentHash: z.string().min(16).max(128),
      slaHours: z.number(),
      penaltyBps: z.number().int().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        sku: { type: "string" },
        buyer: { type: "string" },
        seller: { type: "string" },
        amountUsd: { type: ["number", "string"] },
        contentHash: { type: "string" },
        slaHours: { type: "number" },
        penaltyBps: { type: "integer" },
      },
      required: ["sku", "buyer", "seller", "amountUsd", "contentHash", "slaHours"],
    },
    example: {
      sku: "fetch_url",
      buyer: "0xbuyer",
      seller: "0xseller",
      amountUsd: "0.012",
      contentHash: "abc123def4567890",
      slaHours: 2,
    },
    handler: async (args: Record<string, unknown>) =>
      quoteReceiptSlaPack({
        sku: String(args.sku),
        buyer: String(args.buyer),
        seller: String(args.seller),
        amountUsd: args.amountUsd,
        contentHash: String(args.contentHash),
        slaHours: args.slaHours,
        penaltyBps: args.penaltyBps,
      }),
  },
  {
    name: "validate_seller_payload",
    description: `No-eval JSON payload hygiene for untrusted seller responses. Costs ${CONFIG.prices.validateSellerPayload} USDC per call.`,
    price: CONFIG.prices.validateSellerPayload,
    zodShape: {
      payload: z.unknown(),
      requiredKeys: z.array(z.string()).max(30).optional(),
      maxBytes: z.number().int().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        payload: {},
        requiredKeys: { type: "array", items: { type: "string" }, maxItems: 30 },
        maxBytes: { type: "integer" },
      },
      required: ["payload"],
    },
    example: { payload: { status: "settled", txHash: "0xabc" }, requiredKeys: ["status", "txHash"] },
    handler: async (args: Record<string, unknown>) =>
      validateSellerPayload({
        payload: args.payload,
        requiredKeys: args.requiredKeys as string[] | undefined,
        maxBytes: args.maxBytes === undefined ? undefined : Number(args.maxBytes),
      }),
  },
];
