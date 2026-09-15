import { z } from "zod";

import { CONFIG } from "./config.js";
import { probeFacilitatorsLive, screenAsset, settlementEconomics } from "./a2a-rail-guard.js";

export const A2A_RAIL_TOOLS = [
  {
    name: "screen_asset",
    description: `Allowlist/denylist + known-USDC screen for an x402 settlement token. Costs ${CONFIG.prices.screenAsset} USDC per call.`,
    price: CONFIG.prices.screenAsset,
    zodShape: {
      token: z.string(),
      chainId: z.string().optional(),
      allowlist: z.array(z.string()).max(50).optional(),
      denylist: z.array(z.string()).max(50).optional(),
      requireKnownStable: z.boolean().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        token: { type: "string" },
        chainId: { type: "string" },
        allowlist: { type: "array", items: { type: "string" }, maxItems: 50 },
        denylist: { type: "array", items: { type: "string" }, maxItems: 50 },
        requireKnownStable: { type: "boolean" },
      },
      required: ["token"],
    },
    example: {
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      chainId: "eip155:8453",
      requireKnownStable: true,
    },
    handler: async (args: Record<string, unknown>) =>
      screenAsset({
        token: String(args.token),
        chainId: args.chainId as string | undefined,
        allowlist: args.allowlist as string[] | undefined,
        denylist: args.denylist as string[] | undefined,
        requireKnownStable: args.requireKnownStable as boolean | undefined,
      }),
  },
  {
    name: "settlement_economics",
    description: `All-in USD cost of an x402 purchase: listed price + gas + facilitator fee, with cheapest-chain hint. Costs ${CONFIG.prices.settlementEconomics} USDC per call.`,
    price: CONFIG.prices.settlementEconomics,
    zodShape: {
      listedPriceUsd: z.union([z.number(), z.string()]),
      estimatedGasUsd: z.union([z.number(), z.string()]),
      facilitatorFeeUsd: z.union([z.number(), z.string()]).optional(),
      chains: z
        .array(z.object({ name: z.string(), gasUsd: z.union([z.number(), z.string()]) }))
        .max(8)
        .optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        listedPriceUsd: { type: ["number", "string"] },
        estimatedGasUsd: { type: ["number", "string"] },
        facilitatorFeeUsd: { type: ["number", "string"] },
        chains: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            properties: { name: { type: "string" }, gasUsd: { type: ["number", "string"] } },
            required: ["name", "gasUsd"],
          },
        },
      },
      required: ["listedPriceUsd", "estimatedGasUsd"],
    },
    example: {
      listedPriceUsd: "0.01",
      estimatedGasUsd: "0.0015",
      facilitatorFeeUsd: "0.001",
      chains: [
        { name: "base", gasUsd: "0.0015" },
        { name: "solana", gasUsd: "0.0002" },
      ],
    },
    handler: async (args: Record<string, unknown>) => settlementEconomics(args),
  },
  {
    name: "probe_facilitators",
    description: `Live HTTP probe of 1-8 x402 facilitators in one paid call; returns the first healthy low-latency rail. Costs ${CONFIG.prices.probeFacilitators} USDC per call.`,
    price: CONFIG.prices.probeFacilitators,
    zodShape: {
      urls: z
        .array(z.object({ name: z.string(), url: z.string().url() }))
        .min(1)
        .max(8)
        .optional(),
      timeoutMs: z.number().int().min(200).max(8000).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: { name: { type: "string" }, url: { type: "string" } },
            required: ["name", "url"],
          },
        },
        timeoutMs: { type: "integer", minimum: 200, maximum: 8000 },
      },
    },
    example: {
      urls: [
        { name: "cdp", url: "https://api.cdp.coinbase.com/platform/v2/x402/supported" },
        { name: "xpay", url: "https://facilitator.xpay.sh/supported" },
      ],
      timeoutMs: 2500,
    },
    handler: async (args: Record<string, unknown>) => {
      const urls = args.urls as Array<{ name: string; url: string }> | undefined;
      const timeoutMs = (args.timeoutMs as number | undefined) ?? 2500;
      return urls ? probeFacilitatorsLive(urls, timeoutMs) : probeFacilitatorsLive(undefined, timeoutMs);
    },
  },
];
