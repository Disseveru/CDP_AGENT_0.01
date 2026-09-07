import { z } from "zod";

import { CONFIG } from "./config.js";
import type { ExtraPaidToolDefinition } from "./paid-tools-extra.js";
import { compareSellerQuotes, decode402Payload, probeX402Endpoint } from "./x402-commerce.js";

export const X402_MARKET_TOOLS: ExtraPaidToolDefinition[] = [
  {
    name: "decode_402",
    description: `Parse an HTTP 402 / x402 accepts payload into scheme, network, payTo, and USD price. Costs ${CONFIG.prices.decode402} USDC per call.`,
    price: CONFIG.prices.decode402,
    zodShape: {
      payload: z.unknown().describe("Raw 402 JSON body or accepts array"),
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
    handler: async (args) => decode402Payload(args.payload, args.httpStatus as number | undefined),
  },
  {
    name: "compare_seller_quotes",
    description: `Rank up to 20 x402 sellers by USDC price so a buyer agent picks the cheapest safe quote. Costs ${CONFIG.prices.compareSellerQuotes} USDC per call.`,
    price: CONFIG.prices.compareSellerQuotes,
    zodShape: {
      quotes: z
        .array(
          z.object({
            name: z.string().optional(),
            url: z.string().optional(),
            priceUsd: z.union([z.number(), z.string()]),
            network: z.string().optional(),
          }),
        )
        .min(1)
        .max(20),
    },
    jsonSchema: {
      type: "object",
      properties: {
        quotes: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              url: { type: "string" },
              priceUsd: { type: ["number", "string"] },
              network: { type: "string" },
            },
            required: ["priceUsd"],
          },
        },
      },
      required: ["quotes"],
    },
    example: {
      quotes: [
        { name: "exa-search", priceUsd: "0.007", network: "base" },
        { name: "blockrun-chat", priceUsd: "$0.001", network: "base" },
      ],
    },
    handler: async (args) => compareSellerQuotes(args.quotes as never),
  },
  {
    name: "probe_x402_endpoint",
    description: `SSRF-safe probe of a public URL for HTTP 402 + /.well-known/x402.json. Costs ${CONFIG.prices.probeX402} USDC per call.`,
    price: CONFIG.prices.probeX402,
    zodShape: {
      url: z.string().url(),
      method: z.enum(["GET", "HEAD", "OPTIONS"]).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        method: { type: "string", enum: ["GET", "HEAD", "OPTIONS"] },
      },
      required: ["url"],
    },
    example: { url: "https://api.exa.ai/search", method: "GET" },
    handler: async (args) => probeX402Endpoint({ url: args.url, method: args.method }),
  },
];
