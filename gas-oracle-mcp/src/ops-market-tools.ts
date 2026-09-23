import { z } from "zod";

import { CONFIG } from "./config.js";
import {
  buildSellerDossier,
  consumePaySession,
  issuePaySession,
  receiptSlaPack,
  validateSellerPayload,
  verifyPaySession,
  type PaySession,
} from "./ops-sku.js";

export const OPS_MARKET_TOOLS = [
  {
    name: "issue_pay_session",
    description: `Issue an HMAC pay-session token with a hard USDC budget and optional SKU allowlist for child agents. Costs ${CONFIG.prices.issuePaySession} USDC per call.`,
    price: CONFIG.prices.issuePaySession,
    zodShape: {
      parentAgent: z.string().min(1).max(128),
      childAgent: z.string().min(1).max(128),
      budgetUsd: z.union([z.number(), z.string()]),
      allowlistSkus: z.array(z.string()).max(40).optional(),
      ttlSeconds: z.number().int().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        parentAgent: { type: "string" },
        childAgent: { type: "string" },
        budgetUsd: { type: ["number", "string"] },
        allowlistSkus: { type: "array", items: { type: "string" }, maxItems: 40 },
        ttlSeconds: { type: "integer" },
      },
      required: ["parentAgent", "childAgent", "budgetUsd"],
    },
    example: {
      parentAgent: "orchestrator-1",
      childAgent: "buyer-child-7",
      budgetUsd: "0.25",
      allowlistSkus: ["quote_gas", "probe_x402_endpoint"],
      ttlSeconds: 3600,
    },
    handler: async (args: Record<string, unknown>) =>
      issuePaySession({
        parentAgent: String(args.parentAgent),
        childAgent: String(args.childAgent),
        budgetUsd: args.budgetUsd,
        allowlistSkus: args.allowlistSkus as string[] | undefined,
        ttlSeconds: args.ttlSeconds,
      }),
  },
  {
    name: "consume_pay_session",
    description: `Verify and debit a child-agent pay session for one SKU. Costs ${CONFIG.prices.consumePaySession} USDC per call.`,
    price: CONFIG.prices.consumePaySession,
    zodShape: {
      session: z.object({
        sessionId: z.string(),
        parentAgent: z.string(),
        childAgent: z.string(),
        budgetUsd: z.string(),
        spentUsd: z.string(),
        remainingUsd: z.string(),
        allowlistSkus: z.array(z.string()),
        expiresAt: z.string(),
        issuedAt: z.string(),
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
      consumePaySession({
        session: args.session as PaySession,
        sku: String(args.sku),
        amountUsd: args.amountUsd,
      }),
  },
  {
    name: "verify_pay_session",
    description: `Check HMAC + expiry on a pay session without debiting. Costs ${CONFIG.prices.verifyPaySession} USDC per call.`,
    price: CONFIG.prices.verifyPaySession,
    zodShape: {
      session: z.object({
        sessionId: z.string(),
        parentAgent: z.string(),
        childAgent: z.string(),
        budgetUsd: z.string(),
        spentUsd: z.string(),
        remainingUsd: z.string(),
        allowlistSkus: z.array(z.string()),
        expiresAt: z.string(),
        issuedAt: z.string(),
        signature: z.string(),
      }),
    },
    jsonSchema: {
      type: "object",
      properties: { session: { type: "object" } },
      required: ["session"],
    },
    handler: async (args: Record<string, unknown>) => verifyPaySession(args.session as PaySession),
  },
  {
    name: "validate_seller_payload",
    description: `Sandbox-safe JSON hygiene: size/depth caps, secret-key redaction, required-key check, SHA-256 content hash. No code execution. Costs ${CONFIG.prices.validateSellerPayload} USDC per call.`,
    price: CONFIG.prices.validateSellerPayload,
    zodShape: {
      payload: z.unknown(),
      requiredKeys: z.array(z.string()).max(20).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        payload: {},
        requiredKeys: { type: "array", items: { type: "string" }, maxItems: 20 },
      },
      required: ["payload"],
    },
    example: { payload: { accepts: [{ scheme: "exact" }] }, requiredKeys: ["accepts"] },
    handler: async (args: Record<string, unknown>) =>
      validateSellerPayload({
        payload: args.payload,
        requiredKeys: args.requiredKeys as string[] | undefined,
      }),
  },
  {
    name: "seller_host_dossier",
    description: `Compose a seller-host trust dossier from 402 hygiene + optional 30d payer stats. Not a token-risk clone. Costs ${CONFIG.prices.sellerHostDossier} USDC per call.`,
    price: CONFIG.prices.sellerHostDossier,
    zodShape: {
      host: z.string().max(253).optional(),
      payload: z.unknown().optional(),
      uniquePayers30d: z.number().optional(),
      medianTicketUsd: z.union([z.number(), z.string()]).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        payload: {},
        uniquePayers30d: { type: "number" },
        medianTicketUsd: { type: ["number", "string"] },
      },
    },
    example: {
      host: "api.example.com",
      uniquePayers30d: 12,
      medianTicketUsd: "0.01",
      payload: {
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            payTo: "0x0000000000000000000000000000000000000001",
          },
        ],
      },
    },
    handler: async (args: Record<string, unknown>) =>
      buildSellerDossier({
        host: args.host as string | undefined,
        payload: args.payload,
        uniquePayers30d: args.uniquePayers30d,
        medianTicketUsd: args.medianTicketUsd,
      }),
  },
  {
    name: "receipt_sla_pack",
    description: `Bundle: hash payload + HMAC delivery receipt + SLA hold/penalty quote in one paid call. Costs ${CONFIG.prices.receiptSlaPack} USDC per call.`,
    price: CONFIG.prices.receiptSlaPack,
    zodShape: {
      sku: z.string(),
      buyer: z.string(),
      seller: z.string(),
      amountUsd: z.union([z.number(), z.string()]),
      payload: z.unknown().optional(),
      slaHours: z.number().optional(),
      penaltyBps: z.number().int().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        sku: { type: "string" },
        buyer: { type: "string" },
        seller: { type: "string" },
        amountUsd: { type: ["number", "string"] },
        payload: {},
        slaHours: { type: "number" },
        penaltyBps: { type: "integer" },
      },
      required: ["sku", "buyer", "seller", "amountUsd"],
    },
    example: {
      sku: "quote_gas",
      buyer: "0xbuyer",
      seller: "0xseller",
      amountUsd: "0.002",
      slaHours: 1,
    },
    handler: async (args: Record<string, unknown>) =>
      receiptSlaPack({
        sku: String(args.sku),
        buyer: String(args.buyer),
        seller: String(args.seller),
        amountUsd: args.amountUsd,
        payload: args.payload,
        slaHours: args.slaHours,
        penaltyBps: args.penaltyBps,
      }),
  },
];
