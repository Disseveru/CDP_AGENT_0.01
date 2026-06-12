/**
 * ChainPulse Preflight - x402-paid MCP server.
 *
 * Autonomous agents call these tools before signing or broadcasting transactions
 * to avoid reverts, wasted gas, and failed token transfers. Revenue lands in the
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
import {
  simulateErc20Transfer,
  simulateTransaction,
  SUPPORTED_CHAINS,
} from "./preflight.js";
import { buildAccepts, buildDiscoveryExtension, createResourceServer } from "./payments.js";
import { initializeOracleIdentity } from "./wallet.js";

const chainEnum = z.enum([...SUPPORTED_CHAINS] as [string, ...string[]]);

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
    name: "simulate_transaction",
    description:
      `Dry-run any EVM transaction against live chain state before signing. Returns willSucceed, exact gas estimate, decoded revert reason, and balance warnings. Supports ${SUPPORTED_CHAINS.join(", ")}. Costs ${CONFIG.prices.simulateTransaction} USDC per call. Call this before every on-chain action.`,
    price: CONFIG.prices.simulateTransaction,
    zodShape: {
      chain: chainEnum.describe(`Chain to simulate on. One of: ${SUPPORTED_CHAINS.join(", ")}`),
      from: z.string().describe("Sender address (0x...)"),
      to: z.string().describe("Target contract or recipient (0x...)"),
      data: z
        .string()
        .optional()
        .describe("Calldata hex (0x...). Omit or use 0x for plain ETH transfers."),
      value: z
        .string()
        .optional()
        .describe("Value in wei as a decimal string. Defaults to 0."),
    },
    jsonSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: [...SUPPORTED_CHAINS] },
        from: { type: "string", description: "Sender address" },
        to: { type: "string", description: "Target address" },
        data: { type: "string", description: "Calldata hex" },
        value: { type: "string", description: "Value in wei" },
      },
      required: ["chain", "from", "to"],
    },
    example: {
      chain: "base-sepolia",
      from: "0x0000000000000000000000000000000000000001",
      to: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      data: "0x",
      value: "0",
    },
    outputExample: {
      willSucceed: true,
      gasEstimate: "65000",
      estimatedFeeEth: "0.000325",
      revertReason: null,
      warnings: [],
    },
    handler: async (args) =>
      simulateTransaction({
        chain: String(args.chain) as (typeof SUPPORTED_CHAINS)[number],
        from: String(args.from),
        to: String(args.to),
        data: args.data != null ? String(args.data) : undefined,
        value: args.value != null ? String(args.value) : undefined,
      }),
  },
  {
    name: "simulate_erc20_transfer",
    description:
      `Dry-run an ERC-20 transfer before signing. Checks token balance, simulates transfer() on live state, and returns revert reasons for honeypots, pauses, or blacklists. Supports ${SUPPORTED_CHAINS.join(", ")}. Costs ${CONFIG.prices.simulateErc20Transfer} USDC per call.`,
    price: CONFIG.prices.simulateErc20Transfer,
    zodShape: {
      chain: chainEnum.describe(`Chain to simulate on. One of: ${SUPPORTED_CHAINS.join(", ")}`),
      token: z.string().describe("ERC-20 token contract address (0x...)"),
      from: z.string().describe("Sender/token holder address (0x...)"),
      to: z.string().describe("Recipient address (0x...)"),
      amount: z.string().describe('Human-readable amount, e.g. "10.5" (uses token decimals)'),
    },
    jsonSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: [...SUPPORTED_CHAINS] },
        token: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        amount: { type: "string" },
      },
      required: ["chain", "token", "from", "to", "amount"],
    },
    example: {
      chain: "base-sepolia",
      token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      from: "0x0000000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002",
      amount: "1.0",
    },
    outputExample: {
      willSucceed: false,
      symbol: "USDC",
      revertReason: "ERC20: transfer amount exceeds balance",
      warnings: ["Insufficient USDC balance: have 0.0, need 1.0."],
    },
    handler: async (args) =>
      simulateErc20Transfer({
        chain: String(args.chain) as (typeof SUPPORTED_CHAINS)[number],
        token: String(args.token),
        from: String(args.from),
        to: String(args.to),
        amount: String(args.amount),
      }),
  },
];

interface PreparedTool {
  definition: PaidToolDefinition;
  accepts: PaymentRequirements[];
  extensions: Record<string, unknown>;
}

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
        tags: ["preflight", "simulation", "evm", "safety", "transaction"],
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
    console.log(`[boot] ChainPulse Preflight listening on port ${CONFIG.port}`);
    console.log(`[boot] MCP endpoint:  ${CONFIG.publicUrl}/mcp`);
    console.log(`[boot] Revenue wallet (payTo): ${identity.address}`);
    console.log(`[boot] Paid tools: ${tools.map((t) => `${t.definition.name} (${t.definition.price})`).join(", ")}`);
  });
}

main().catch((error) => {
  console.error("Fatal startup error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
