/**
 * AgentWire - x402-paid MCP server.
 *
 * Gives autonomous agents two things they cannot easily build themselves:
 *  1. Inbound webhooks (Stripe, GitHub, humans → agent inbox)
 *  2. Real web fetch (URL → clean text + content hash)
 *
 * Revenue lands in the CDP AgentKit wallet initialized at boot.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPaymentWrapper } from "@x402/mcp";
import type {
  HTTPAdapter,
  HTTPRequestContext,
  HTTPResponseInstructions,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import express from "express";
import type { Request, Response } from "express";
import { z } from "zod";

import { CONFIG } from "./config.js";
import { fetchUrl } from "./fetch.js";
import { createInbox, drainInbox, peekInbox } from "./inbox.js";
import { appendEvent, inboxExists } from "./store.js";
import {
  buildAccepts,
  buildDiscoveryExtension,
  createDiscoveryHttpServer,
  createResourceServer,
} from "./payments.js";
import { initializeOracleIdentity } from "./wallet.js";
import type { OracleIdentity } from "./wallet.js";

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
    name: "drain_inbox",
    description:
      `Pull all pending webhook events from your AgentWire inbox and clear the queue. ` +
      `Use this in your agent loop to receive Stripe payments, GitHub PR events, form submissions, ` +
      `or human replies. Costs ${CONFIG.prices.drainInbox} USDC per call.`,
    price: CONFIG.prices.drainInbox,
    zodShape: {
      inboxId: z.string().describe("Inbox ID returned by create_inbox"),
      secret: z.string().describe("Inbox secret returned by create_inbox — never share publicly"),
    },
    jsonSchema: {
      type: "object",
      properties: {
        inboxId: { type: "string" },
        secret: { type: "string" },
      },
      required: ["inboxId", "secret"],
    },
    example: { inboxId: "abc123", secret: "your-secret-here" },
    outputExample: {
      drained: 2,
      events: [{ id: "ev1", receivedAt: "2026-06-12T00:00:00.000Z", body: { type: "payment" } }],
    },
    handler: async (args) =>
      drainInbox({ inboxId: String(args.inboxId), secret: String(args.secret) }),
  },
  {
    name: "peek_inbox",
    description:
      `Read pending webhook events without clearing the queue. ` +
      `Costs ${CONFIG.prices.peekInbox} USDC per call.`,
    price: CONFIG.prices.peekInbox,
    zodShape: {
      inboxId: z.string().describe("Inbox ID returned by create_inbox"),
      secret: z.string().describe("Inbox secret returned by create_inbox"),
    },
    jsonSchema: {
      type: "object",
      properties: {
        inboxId: { type: "string" },
        secret: { type: "string" },
      },
      required: ["inboxId", "secret"],
    },
    example: { inboxId: "abc123", secret: "your-secret-here" },
    outputExample: { pending: 1, events: [] },
    handler: async (args) =>
      peekInbox({ inboxId: String(args.inboxId), secret: String(args.secret) }),
  },
  {
    name: "fetch_url",
    description:
      `Fetch a public web page or API and return agent-readable text plus a SHA-256 content hash. ` +
      `Use for research, monitoring, reading docs, or verifying what a URL contained at fetch time. ` +
      `Costs ${CONFIG.prices.fetchUrl} USDC per call.`,
    price: CONFIG.prices.fetchUrl,
    zodShape: {
      url: z.string().url().describe("Public http(s) URL to fetch"),
      headers: z
        .record(z.string())
        .optional()
        .describe('Optional request headers, e.g. {"Accept-Language":"en-US"}'),
    },
    jsonSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http(s) URL" },
        headers: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["url"],
    },
    example: { url: "https://example.com" },
    outputExample: {
      status: 200,
      title: "Example Domain",
      text: "Example Domain This domain is for use in illustrative examples...",
      contentSha256: "abc123...",
    },
    handler: async (args) =>
      fetchUrl({
        url: String(args.url),
        headers: args.headers as Record<string, string> | undefined,
      }),
  },
];

interface PreparedTool {
  definition: PaidToolDefinition;
  accepts: PaymentRequirements[];
  extensions: Record<string, unknown>;
}

interface RuntimeState {
  status: "starting" | "ready" | "error";
  identity?: OracleIdentity;
  resourceServer?: x402ResourceServer;
  discoveryHttpServer?: x402HTTPResourceServer;
  tools?: PreparedTool[];
  error?: string;
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

async function initializeRuntime(state: RuntimeState): Promise<void> {
  try {
    const identity = await initializeOracleIdentity();
    const resourceServer = await createResourceServer();
    const tools = await prepareTools(resourceServer, identity.address);
    const discoveryHttpServer = await createDiscoveryHttpServer(resourceServer, identity.address);

    state.identity = identity;
    state.resourceServer = resourceServer;
    state.discoveryHttpServer = discoveryHttpServer;
    state.tools = tools;
    state.status = "ready";
    state.error = undefined;
  } catch (error) {
    state.status = "error";
    state.error = error instanceof Error ? error.message : String(error);
    console.error("Fatal initialization error:", error);
  }
}

function isReady(state: RuntimeState): state is RuntimeState & {
  status: "ready";
  identity: OracleIdentity;
  resourceServer: x402ResourceServer;
  discoveryHttpServer: x402HTTPResourceServer;
  tools: PreparedTool[];
} {
  return Boolean(
    state.status === "ready" &&
      state.identity &&
      state.resourceServer &&
      state.discoveryHttpServer &&
      state.tools,
  );
}

function buildServiceCard(state: RuntimeState): Record<string, unknown> {
  const tools = state.tools || [];
  return {
    service: CONFIG.serviceName,
    version: CONFIG.serviceVersion,
    status: state.status,
    tagline: "Webhook inbox + web fetch for autonomous agents",
    protocol: "MCP over Streamable HTTP + x402 v2 payments",
    endpoint: `${CONFIG.publicUrl}/mcp`,
    webhooks: `${CONFIG.publicUrl}/hooks/{inboxId}`,
    paymentNetwork: CONFIG.caip2Network,
    facilitator: CONFIG.facilitatorUrl,
    payTo: state.identity?.address,
    error: state.error,
    tools: [
      { name: "create_inbox", price: "free" },
      ...tools.map((t) => ({ name: t.definition.name, price: t.definition.price })),
      { name: "ping", price: "free" },
    ],
  };
}

function createExpressHttpAdapter(req: Request): HTTPAdapter {
  return {
    getHeader: (name: string) => req.get(name),
    getMethod: () => req.method,
    getPath: () => req.path,
    getUrl: () => `${CONFIG.publicUrl.replace(/\/$/, "")}${req.originalUrl}`,
    getAcceptHeader: () => req.get("accept") || "",
    getUserAgent: () => req.get("user-agent") || "",
    getQueryParams: () =>
      Object.fromEntries(
        Object.entries(req.query).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.map((v) => String(v)) : String(value ?? ""),
        ]),
      ),
    getQueryParam: (name: string) => {
      const value = req.query[name];
      if (value === undefined) return undefined;
      return Array.isArray(value) ? value.map((v) => String(v)) : String(value);
    },
    getBody: () => req.body,
  };
}

function writeHttpInstructions(res: Response, instructions: HTTPResponseInstructions): void {
  res.status(instructions.status);
  for (const [name, value] of Object.entries(instructions.headers)) {
    res.setHeader(name, value);
  }

  if (instructions.body === undefined) {
    res.end();
    return;
  }

  if (instructions.isHtml || typeof instructions.body === "string" || Buffer.isBuffer(instructions.body)) {
    res.send(instructions.body);
    return;
  }

  res.json(instructions.body);
}

async function handleDiscoveryRequest(
  req: Request,
  res: Response,
  state: RuntimeState,
): Promise<void> {
  if (!isReady(state)) {
    res.status(503).json(buildServiceCard(state));
    return;
  }

  const requestContext: HTTPRequestContext = {
    adapter: createExpressHttpAdapter(req),
    path: req.path,
    method: req.method,
    paymentHeader: req.get("payment-signature"),
  };
  const paymentResult = await state.discoveryHttpServer.processHTTPRequest(requestContext);

  if (paymentResult.type === "payment-error") {
    writeHttpInstructions(res, paymentResult.response);
    return;
  }

  const body = buildServiceCard(state);

  if (paymentResult.type === "payment-verified") {
    const responseBody = Buffer.from(JSON.stringify(body));
    const settlement = await state.discoveryHttpServer.processSettlement(
      paymentResult.paymentPayload,
      paymentResult.paymentRequirements,
      paymentResult.declaredExtensions,
      {
        request: requestContext,
        responseBody,
        responseHeaders: { "Content-Type": "application/json" },
      },
    );

    if (!settlement.success) {
      writeHttpInstructions(res, settlement.response);
      return;
    }

    for (const [name, value] of Object.entries(settlement.headers)) {
      res.setHeader(name, value);
    }
  }

  res.json(body);
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
        tags: ["webhook", "inbox", "fetch", "agent-infrastructure", "relay"],
      },
      extensions,
      hooks: {
        onBeforeExecution: async () => {
          console.log(`[x402] Payment verified for ${definition.name}, executing...`);
        },
        onAfterSettlement: async ({ settlement }) => {
          console.log(`[x402] Settled ${definition.name} tx=${settlement.transaction}`);
        },
      },
    });

    mcpServer.tool(
      definition.name,
      definition.description,
      definition.zodShape,
      paid(async (args) => ({
        content: [
          { type: "text" as const, text: JSON.stringify(await definition.handler(args), null, 2) },
        ],
      })),
    );
  }

  // Free: agents need an inbox before they can pay to drain it.
  mcpServer.tool(
    "create_inbox",
    "Create a free webhook inbox. Returns inboxId, secret, and webhookUrl. POST any JSON to webhookUrl; drain_inbox pulls events into your agent.",
    {},
    async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(createInbox(), null, 2) }],
    }),
  );

  mcpServer.tool("ping", "Free health check. Returns service status and pricing.", {}, async () => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: "ok",
          service: CONFIG.serviceName,
          paymentNetwork: CONFIG.caip2Network,
          freeTools: ["create_inbox", "ping"],
          paidTools: tools.map((t) => ({ name: t.definition.name, price: t.definition.price })),
        }),
      },
    ],
  }));

  return mcpServer;
}

async function main(): Promise<void> {
  console.log(`[boot] ${CONFIG.serviceName} v${CONFIG.serviceVersion} starting...`);

  const app = express();
  const state: RuntimeState = { status: "starting" };

  app.use(express.json({ limit: "1mb" }));
  app.use(express.text({ type: ["text/*", "application/xml"], limit: "1mb" }));

  // Inbound webhook relay — external services POST here, agents drain via MCP.
  app.all("/hooks/:inboxId", (req, res) => {
    const { inboxId } = req.params;
    if (!inboxExists(inboxId)) {
      res.status(404).json({ error: "Unknown inbox" });
      return;
    }

    try {
      const body =
        req.body === undefined || req.body === ""
          ? null
          : typeof req.body === "string"
            ? req.body
            : req.body;

      const event = appendEvent(inboxId, {
        method: req.method,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]),
        ),
        query: Object.fromEntries(
          Object.entries(req.query).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]),
        ),
        body,
      });

      console.log(`[hook] ${req.method} inbox=${inboxId} event=${event.id}`);
      res.status(202).json({ accepted: true, eventId: event.id, receivedAt: event.receivedAt });
    } catch (error) {
      console.error("[hook] Error:", error);
      res.status(500).json({ error: "Failed to store event" });
    }
  });

  app.post("/mcp", async (req, res) => {
    if (!isReady(state)) {
      res.status(503).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `AgentWire is ${state.status}`,
          data: state.error,
        },
        id: null,
      });
      return;
    }

    try {
      const mcpServer = buildMcpServer(state.resourceServer, state.tools);
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

  app.get("/", (req, res, next) => {
    handleDiscoveryRequest(req, res, state).catch(next);
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: CONFIG.serviceName,
      runtimeStatus: state.status,
      payTo: state.identity?.address,
      network: CONFIG.caip2Network,
      error: state.error,
    });
  });

  app.get("/ready", (_req, res) => {
    if (!isReady(state)) {
      res.status(503).json({
        status: state.status,
        service: CONFIG.serviceName,
        network: CONFIG.caip2Network,
        error: state.error,
      });
      return;
    }

    res.json({
      status: "ready",
      service: CONFIG.serviceName,
      payTo: state.identity.address,
      network: CONFIG.caip2Network,
    });
  });

  app.listen(CONFIG.port, "0.0.0.0", () => {
    console.log(`[boot] AgentWire listening on port ${CONFIG.port}`);
    console.log(`[boot] MCP endpoint:     ${CONFIG.publicUrl}/mcp`);
    console.log(`[boot] Webhook pattern:  ${CONFIG.publicUrl}/hooks/{inboxId}`);
    void initializeRuntime(state).then(() => {
      if (isReady(state)) {
        console.log(`[boot] Revenue wallet:   ${state.identity.address}`);
        console.log(
          `[boot] Paid tools: ${state.tools.map((t) => `${t.definition.name} (${t.definition.price})`).join(", ")}`,
        );
      }
    });
  });
}

main().catch((error) => {
  console.error("Fatal startup error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
