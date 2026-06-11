/**
 * ChainPulse Gas Oracle - x402-paid MCP server.
 *
 * Autonomous agents connect over Streamable HTTP, discover the tools, and pay
 * USDC micro-payments (x402 "exact" scheme) per call. Revenue lands in the
 * CDP AgentKit server wallet initialized at boot.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPaymentWrapper } from "@x402/mcp";
import type { x402ResourceServer } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import express from "express";
import { z } from "zod";

import { CONFIG } from "./config.js";
import { getGasSnapshot, recommendCheapestChain, TX_TYPES } from "./gas.js";
import { buildAccepts, buildDiscoveryExtension, createResourceServer } from "./payments.js";
import { initializeOracleIdentity } from "./wallet.js";

interface PaidToolDefinition {
  name: string;
  description: string;
  price: string;
  zodShape: Record<string, z.ZodTypeAny>;
  jsonSchema: Record<string, unknown>;
  example?: Record<string, unknown>;
  outputExample?: unknown;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const TOOL_DEFINITIONS: PaidToolDefinition[] = [
  {
    name: "get_gas_snapshot",
    description:
      `Real-time EIP-1559 gas prices (max fee + priority fee in gwei) and latest block for Base, Ethereum, Arbitrum One, and OP Mainnet, plus the live ETH-USD rate. Refreshed every 5 seconds. Costs ${CONFIG.prices.gasSnapshot} USDC per call.`,
    price: CONFIG.prices.gasSnapshot,
    zodShape: {},
    jsonSchema: { type: "object", properties: {}, required: [] },
    example: {},
    outputExample: {
      timestamp: "2026-06-10T12:00:00.000Z",
      ethUsd: 2500.12,
      chains: [
        {
          chain: "base",
          label: "Base",
          chainId: 8453,
          maxFeePerGasWei: "5000000",
          maxFeePerGasGwei: "0.005",
          maxPriorityFeePerGasGwei: "0.001",
          blockNumber: "31000000",
        },
      ],
      errors: {},
    },
    handler: async () => getGasSnapshot(),
  },
  {
    name: "recommend_cheapest_chain",
    description:
      `Ranks Base, Ethereum, Arbitrum One, and OP Mainnet by estimated USD execution cost for a transaction type (${TX_TYPES.join(", ")}) and recommends the cheapest chain with projected savings. Costs ${CONFIG.prices.recommend} USDC per call.`,
    price: CONFIG.prices.recommend,
    zodShape: {
      txType: z
        .enum(TX_TYPES as [string, ...string[]])
        .describe(`Transaction archetype to estimate. One of: ${TX_TYPES.join(", ")}`),
    },
    jsonSchema: {
      type: "object",
      properties: {
        txType: {
          type: "string",
          enum: TX_TYPES,
          description: `Transaction archetype to estimate. One of: ${TX_TYPES.join(", ")}`,
        },
      },
      required: ["txType"],
    },
    example: { txType: "swap" },
    outputExample: {
      timestamp: "2026-06-10T12:00:00.000Z",
      txType: "swap",
      gasUnits: "200000",
      ethUsd: 2500.12,
      cheapest: { chain: "base", label: "Base", estimatedFeeUsd: "0.002500" },
      ranking: [],
      maxSavingsUsd: "4.812000",
    },
    handler: async (args) => recommendCheapestChain(String(args.txType)),
  },
];

interface PreparedTool {
  definition: PaidToolDefinition;
  accepts: PaymentRequirements[];
  extensions: Record<string, unknown>;
}

/**
 * Pre-computes payment requirements and validated Bazaar discovery metadata
 * for every paid tool. Done once at boot, reused for every request.
 */
async function prepareTools(
  resourceServer: x402ResourceServer,
  payTo: string,
): Promise<PreparedTool[]> {
  return Promise.all(
    TOOL_DEFINITIONS.map(async (definition) => ({
      definition,
      accepts: await buildAccepts(resourceServer, payTo, definition.price),
      extensions: buildDiscoveryExtension({
        toolName: definition.name,
        description: definition.description,
        inputSchema: definition.jsonSchema,
        example: definition.example,
        outputExample: definition.outputExample,
      }),
    })),
  );
}

/**
 * Builds a fresh McpServer wired with the x402 payment wrapper around every
 * paid tool. A new instance is created per request (stateless transport).
 */
function buildMcpServer(resourceServer: x402ResourceServer, tools: PreparedTool[]): McpServer {
  const mcpServer = new McpServer({
    name: CONFIG.serviceName,
    version: CONFIG.serviceVersion,
  });

  for (const { definition, accepts, extensions } of tools) {
    const paid = createPaymentWrapper(resourceServer, {
      accepts,
      resource: {
        url: `mcp://tool/${definition.name}`,
        description: definition.description,
        mimeType: "application/json",
        serviceName: CONFIG.serviceName,
        tags: ["gas", "fees", "cross-chain", "oracle", "optimization"],
      },
      extensions,
      hooks: {
        onBeforeExecution: async () => {
          console.log(`[x402] Payment verified for ${definition.name}, executing tool...`);
        },
        onAfterExecution: async () => {
          console.log(`[x402] ${definition.name} executed, settling payment...`);
        },
        onAfterSettlement: async ({ settlement }) => {
          console.log(`[x402] Settled ${definition.name} payment tx=${settlement.transaction}`);
        },
      },
    });

    mcpServer.tool(
      definition.name,
      definition.description,
      definition.zodShape,
      paid(async (args) => ({
        content: [{ type: "text" as const, text: JSON.stringify(await definition.handler(args), null, 2) }],
      })),
    );
  }

  // Free health-check tool so agents can probe the server without paying.
  mcpServer.tool("ping", "Free health check. Returns service status and payment metadata.", {}, async () => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: "ok",
          service: CONFIG.serviceName,
          paymentNetwork: CONFIG.caip2Network,
          paidTools: tools.map((t) => ({ name: t.definition.name, price: t.definition.price })),
        }),
      },
    ],
  }));

  return mcpServer;
}

async function main(): Promise<void> {
  console.log(`[boot] ${CONFIG.serviceName} v${CONFIG.serviceVersion} starting...`);

  const identity = await initializeOracleIdentity();
  const resourceServer = await createResourceServer();
  const tools = await prepareTools(resourceServer, identity.address);

  const app = express();
  app.use(express.json());

  // MCP endpoint (stateless Streamable HTTP): new server + transport per request.
  app.post("/mcp", async (req, res) => {
    try {
      const mcpServer = buildMcpServer(resourceServer, tools);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[mcp] Request error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. POST JSON-RPC to /mcp." },
      id: null,
    });
  });

  // Human/agent-readable service card.
  app.get("/", (_req, res) => {
    res.json({
      service: CONFIG.serviceName,
      version: CONFIG.serviceVersion,
      protocol: "MCP over Streamable HTTP + x402 v2 payments",
      endpoint: `${CONFIG.publicUrl}/mcp`,
      paymentNetwork: CONFIG.caip2Network,
      facilitator: CONFIG.facilitatorUrl,
      payTo: identity.address,
      tools: [
        ...tools.map((t) => ({ name: t.definition.name, price: t.definition.price })),
        { name: "ping", price: "free" },
      ],
    });
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", payTo: identity.address, network: CONFIG.caip2Network });
  });

  app.listen(CONFIG.port, () => {
    console.log(`[boot] ChainPulse listening on port ${CONFIG.port}`);
    console.log(`[boot] MCP endpoint:  ${CONFIG.publicUrl}/mcp`);
    console.log(`[boot] Revenue wallet (payTo): ${identity.address}`);
    console.log(`[boot] Paid tools: ${tools.map((t) => `${t.definition.name} (${t.definition.price})`).join(", ")}`);
  });
}

main().catch((error) => {
  console.error("Fatal startup error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
