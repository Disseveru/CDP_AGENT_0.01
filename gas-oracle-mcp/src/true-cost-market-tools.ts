import { z } from "zod";

import { CONFIG } from "./config.js";
import { planShopBudget, rankTrueCostShop, type ShopListing } from "./true-cost-shop.js";

export const TRUE_COST_MARKET_TOOLS = [
  {
    name: "rank_true_cost",
    description: `Rank 1-25 x402 seller quotes by all-in USDC cost (listed price × expected retries + chain settlement overhead). Costs ${CONFIG.prices.rankTrueCost} USDC per call.`,
    price: CONFIG.prices.rankTrueCost,
    zodShape: {
      listings: z
        .array(
          z.object({
            id: z.string().optional(),
            name: z.string(),
            url: z.string().optional(),
            network: z.string(),
            listedUsd: z.union([z.number(), z.string()]),
            expectedRetries: z.union([z.number(), z.string()]).optional(),
            uniquePayers30d: z.union([z.number(), z.string()]).optional(),
            calls30d: z.union([z.number(), z.string()]).optional(),
          }),
        )
        .min(1)
        .max(25),
    },
    jsonSchema: {
      type: "object",
      properties: {
        listings: {
          type: "array",
          minItems: 1,
          maxItems: 25,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              url: { type: "string" },
              network: { type: "string" },
              listedUsd: { type: ["number", "string"] },
              expectedRetries: { type: ["number", "string"] },
              uniquePayers30d: { type: ["number", "string"] },
              calls30d: { type: ["number", "string"] },
            },
            required: ["name", "network", "listedUsd"],
          },
        },
      },
      required: ["listings"],
    },
    example: {
      listings: [
        { name: "Exa search", network: "eip155:8453", listedUsd: "0.007", uniquePayers30d: 81, calls30d: 5879 },
        { name: "ETH indexer", network: "eip155:1", listedUsd: "0.005" },
      ],
    },
    handler: async (args: Record<string, unknown>) => rankTrueCostShop(args.listings as ShopListing[]),
  },
  {
    name: "plan_shop_budget",
    description: `How many true-cost calls a USDC balance can buy after reserve. Costs ${CONFIG.prices.planShopBudget} USDC per call.`,
    price: CONFIG.prices.planShopBudget,
    zodShape: {
      balanceUsd: z.union([z.number(), z.string()]),
      reserveUsd: z.union([z.number(), z.string()]).optional(),
      cheapestTrueCostUsd: z.union([z.number(), z.string()]).optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        balanceUsd: { type: ["number", "string"] },
        reserveUsd: { type: ["number", "string"] },
        cheapestTrueCostUsd: { type: ["number", "string"] },
      },
      required: ["balanceUsd"],
    },
    example: { balanceUsd: "1.00", reserveUsd: "0.10", cheapestTrueCostUsd: "0.0072" },
    handler: async (args: Record<string, unknown>) =>
      planShopBudget({
        balanceUsd: args.balanceUsd,
        reserveUsd: args.reserveUsd,
        cheapestTrueCostUsd: args.cheapestTrueCostUsd,
      }),
  },
];
