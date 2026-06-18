/**
 * AgentWire - x402-paid MCP server.
 *
 * Gives autonomous agents two things they cannot easily build themselves:
 *  1. Inbound webhooks (Stripe, GitHub, humans → agent inbox)
 *  2. Real web fetch (URL → clean text + content hash)
 *
 * Revenue lands in the CDP AgentKit wallet initialized at boot.
 */
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPaymentWrapper, MCP_PAYMENT_RESPONSE_META_KEY } from "@x402/mcp";
import type {
  HTTPAdapter,
  HTTPRequestContext,
  HTTPResponseInstructions,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

import { CONFIG } from "./config.js";
import { fetchUrl } from "./fetch.js";
import { createInbox, getInboxStats, peekInbox } from "./inbox.js";
import { extractLinks } from "./links.js";
import { relayPost } from "./relay.js";
import { appendEvent, inboxExists, removeInboxEventsByIds } from "./store.js";
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
    handler: async (args) => {
      const peeked = peekInbox({ inboxId: String(args.inboxId), secret: String(args.secret) });
      return {
        timestamp: peeked.timestamp,
        inboxId: peeked.inboxId,
        drained: peeked.pending,
        events: peeked.events,
      };
    },
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
  {
    name: "inbox_stats",
    description:
      `Check how many webhook events are waiting in an inbox without reading their contents. ` +
      `Cheaper than peek_inbox when you only need a count before draining. ` +
      `Costs ${CONFIG.prices.inboxStats} USDC per call.`,
    price: CONFIG.prices.inboxStats,
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
    outputExample: { pending: 3, oldestEventAt: "2026-06-12T00:00:00.000Z", newestEventAt: "2026-06-12T01:00:00.000Z" },
    handler: async (args) =>
      getInboxStats({ inboxId: String(args.inboxId), secret: String(args.secret) }),
  },
  {
    name: "extract_links",
    description:
      `Fetch a public web page and extract anchor links for research or crawling workflows. ` +
      `Returns href + link text, optionally filtered to same-origin links. ` +
      `Costs ${CONFIG.prices.extractLinks} USDC per call.`,
    price: CONFIG.prices.extractLinks,
    zodShape: {
      url: z.string().url().describe("Public http(s) URL to scan for links"),
      sameOrigin: z.boolean().optional().describe("When true, only return links on the same hostname"),
      limit: z.number().int().min(1).max(500).optional().describe("Max links to return (default 100)"),
    },
    jsonSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        sameOrigin: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["url"],
    },
    example: { url: "https://example.com", sameOrigin: true, limit: 50 },
    outputExample: {
      linkCount: 2,
      links: [{ href: "https://example.com/about", text: "About" }],
    },
    handler: async (args) =>
      extractLinks({
        url: String(args.url),
        sameOrigin: args.sameOrigin as boolean | undefined,
        limit: args.limit as number | undefined,
      }),
  },
  {
    name: "relay_post",
    description:
      `Relay an outbound HTTP POST/PUT/PATCH to a public API on behalf of an agent that cannot ` +
      `make direct outbound requests. Returns the upstream status and response body. ` +
      `Costs ${CONFIG.prices.relayPost} USDC per call.`,
    price: CONFIG.prices.relayPost,
    zodShape: {
      url: z.string().url().describe("Public http(s) URL to call"),
      method: z.enum(["POST", "PUT", "PATCH"]).optional().describe("HTTP method (default POST)"),
      headers: z
        .record(z.string())
        .optional()
        .describe('Optional request headers, e.g. {"Authorization":"Bearer ..."}'),
      body: z.unknown().optional().describe("JSON object or string request body"),
    },
    jsonSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", enum: ["POST", "PUT", "PATCH"] },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: {},
      },
      required: ["url"],
    },
    example: { url: "https://httpbin.org/post", method: "POST", body: { hello: "agent" } },
    outputExample: { status: 200, responseBody: { json: { hello: "agent" } } },
    handler: async (args) =>
      relayPost({
        url: String(args.url),
        method: args.method as "POST" | "PUT" | "PATCH" | undefined,
        headers: args.headers as Record<string, string> | undefined,
        body: args.body,
      }),
  },
];

interface PreparedTool {
  definition: PaidToolDefinition;
  accepts: PaymentRequirements[];
  extensions: Record<string, unknown>;
}

interface RuntimeState {
  status: "starting" | "ready" | "degraded" | "error";
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
    state.identity = identity;

    try {
      const resourceServer = await createResourceServer();
      const tools = await prepareTools(resourceServer, identity.address);
      const discoveryHttpServer = await createDiscoveryHttpServer(resourceServer, identity.address);

      state.resourceServer = resourceServer;
      state.discoveryHttpServer = discoveryHttpServer;
      state.tools = tools;
      state.status = "ready";
      state.error = undefined;
    } catch (paymentError) {
      state.status = "degraded";
      state.tools = [];
      state.error =
        paymentError instanceof Error ? paymentError.message : String(paymentError);
      console.warn(
        `[boot] x402 payments unavailable (${state.error}); free MCP tools still work over /sse and /mcp`,
      );
    }
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

/** True when Cursor SSE and MCP can serve at least free tools. */
function isMcpOperational(state: RuntimeState): state is RuntimeState & {
  identity: OracleIdentity;
  tools: PreparedTool[];
} {
  return Boolean(
    (state.status === "ready" || state.status === "degraded") && state.identity && state.tools,
  );
}

function buildServiceCard(state: RuntimeState): Record<string, unknown> {
  const tools = state.tools || [];
  return {
    service: CONFIG.serviceName,
    version: CONFIG.serviceVersion,
    status: state.status,
    tagline: "Webhook inbox + web fetch + outbound relay for autonomous agents",
    protocol: "MCP over Streamable HTTP + SSE + x402 v2 payments",
    endpoint: `${CONFIG.publicUrl}/mcp`,
    sseEndpoint: `${CONFIG.publicUrl}/sse`,
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

interface PendingDrainAck {
  inboxId: string;
  secret: string;
  eventIds: string[];
}

function paymentKeyFromPayload(payload: unknown): string {
  return JSON.stringify(payload);
}

function paymentKeyFromMeta(meta: Record<string, unknown> | undefined): string | undefined {
  const payment = meta?.["x402/payment"];
  if (!payment || typeof payment !== "object") {
    return undefined;
  }

  return paymentKeyFromPayload(payment);
}

function buildMcpServer(state: RuntimeState): McpServer {
  const mcpServer = new McpServer({
    name: CONFIG.serviceName,
    version: CONFIG.serviceVersion,
  });

  /** Peeks held until x402 settlement succeeds for a matching payment payload. */
  const pendingDrainAcks = new Map<string, PendingDrainAck>();

  if (isReady(state)) {
    for (const { definition, accepts, extensions } of state.tools) {
      const paid = createPaymentWrapper(state.resourceServer, {
        accepts,
        resource: {
          url: `mcp://tool/${definition.name}`,
          description: definition.description,
          mimeType: "application/json",
          serviceName: CONFIG.serviceName,
          tags: ["webhook", "inbox", "fetch", "relay", "agent-infrastructure"],
        },
        extensions,
        hooks: {
          onBeforeExecution: async () => {
            console.log(`[x402] Payment verified for ${definition.name}, executing...`);
          },
          onAfterSettlement: async ({ paymentPayload, settlement }) => {
            const paymentKey = paymentKeyFromPayload(paymentPayload);
            const pending = pendingDrainAcks.get(paymentKey);
            if (pending) {
              if (settlement.success) {
                removeInboxEventsByIds(pending.inboxId, pending.secret, pending.eventIds);
              }
              pendingDrainAcks.delete(paymentKey);
            }

            console.log(`[x402] Settled ${definition.name} tx=${settlement.transaction}`);
          },
        },
      });

      const paidHandler = paid(async (args, context) => {
        const toolResult = await definition.handler(args);
        if (definition.name === "drain_inbox") {
          const paymentKey = paymentKeyFromMeta(context?.meta);
          const events = (toolResult as { events?: { id: string }[] }).events ?? [];
          if (paymentKey) {
            pendingDrainAcks.set(paymentKey, {
              inboxId: String(args.inboxId),
              secret: String(args.secret),
              eventIds: events.map((event) => event.id),
            });
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(toolResult, null, 2),
            },
          ],
        };
      });

      mcpServer.tool(definition.name, definition.description, definition.zodShape, async (args, extra) => {
        const result = await paidHandler(args, extra);
        const settlement = result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY] as
          | { success?: boolean; errorReason?: string }
          | undefined;

        if (settlement?.success === false) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: settlement.errorReason || "Payment settlement failed",
                  settlement,
                }),
              },
            ],
          };
        }

        return result;
      });
    }
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

  const paidTools = isReady(state)
    ? state.tools.map((t) => ({ name: t.definition.name, price: t.definition.price }))
    : TOOL_DEFINITIONS.map((t) => ({ name: t.name, price: t.price }));

  mcpServer.tool("ping", "Free health check. Returns service status and pricing.", {}, async () => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: state.status === "ready" ? "ok" : state.status,
          service: CONFIG.serviceName,
          paymentNetwork: CONFIG.caip2Network,
          freeTools: ["create_inbox", "ping"],
          paidTools,
          paymentsAvailable: state.status === "ready",
          error: state.error,
        }),
      },
    ],
  }));

  return mcpServer;
}

/** Active SSE sessions keyed by sessionId (Cursor IDE and other HTTP+SSE clients). */
const sseTransports = new Map<string, SSEServerTransport>();

function safeCompareSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function isAuthorizedMcpRequest(req: Request): boolean {
  if (!CONFIG.mcpApiKey) return true;

  const authorization = req.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  const apiKey = req.get("x-api-key");

  if (bearer && safeCompareSecret(bearer, CONFIG.mcpApiKey)) return true;
  if (apiKey && safeCompareSecret(apiKey, CONFIG.mcpApiKey)) return true;
  return false;
}

function requireMcpApiKey(req: Request, res: Response, next: NextFunction): void {
  if (isAuthorizedMcpRequest(req)) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}

async function main(): Promise<void> {
  console.log(`[boot] ${CONFIG.serviceName} v${CONFIG.serviceVersion} starting...`);

  const app = express();
  const state: RuntimeState = { status: "starting" };

  // Railway terminates TLS and proxies requests; needed for correct host/proto on SSE POSTs.
  app.set("trust proxy", 1);

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

  app.post("/mcp", requireMcpApiKey, async (req, res) => {
    if (!isMcpOperational(state)) {
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
      const mcpServer = buildMcpServer(state);
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

  // HTTP+SSE transport for Cursor IDE and other remote MCP clients.
  app.get("/sse", requireMcpApiKey, async (req, res) => {
    if (!isMcpOperational(state)) {
      res.status(503).json({
        error: `AgentWire is ${state.status}`,
        details: state.error,
      });
      return;
    }

    try {
      res.setHeader("X-Accel-Buffering", "no");
      const transport = new SSEServerTransport(CONFIG.sseMessagesEndpoint, res);
      sseTransports.set(transport.sessionId, transport);
      res.on("close", () => {
        sseTransports.delete(transport.sessionId);
        void transport.close();
      });

      const mcpServer = buildMcpServer(state);
      await mcpServer.connect(transport);
    } catch (error) {
      console.error("[sse] Connection error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to establish SSE transport" });
      }
    }
  });

  app.post("/messages", requireMcpApiKey, async (req, res) => {
    const sessionId = req.query.sessionId;
    if (typeof sessionId !== "string") {
      res.status(400).send("Missing sessionId query parameter");
      return;
    }

    const transport = sseTransports.get(sessionId);
    if (!transport) {
      res.status(404).send("Unknown SSE session");
      return;
    }

    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      console.error("[sse] Message error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to handle SSE message" });
      }
    }
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
    if (!isMcpOperational(state)) {
      res.status(503).json({
        status: state.status,
        service: CONFIG.serviceName,
        network: CONFIG.caip2Network,
        error: state.error,
      });
      return;
    }

    res.json({
      status: state.status === "ready" ? "ready" : "degraded",
      service: CONFIG.serviceName,
      payTo: state.identity.address,
      network: CONFIG.caip2Network,
      paymentsAvailable: state.status === "ready",
      error: state.error,
    });
  });

  app.listen(CONFIG.port, "0.0.0.0", () => {
    console.log(`[boot] AgentWire listening on 0.0.0.0:${CONFIG.port}`);
    console.log(`[boot] MCP endpoint:     ${CONFIG.publicUrl}/mcp`);
    console.log(`[boot] SSE endpoint:     ${CONFIG.publicUrl}/sse`);
    console.log(`[boot] Webhook pattern:  ${CONFIG.publicUrl}/hooks/{inboxId}`);
    if (CONFIG.mcpApiKey) {
      console.log("[boot] MCP API key auth enabled for /mcp, /sse, and /messages");
    }
    void initializeRuntime(state).then(() => {
      if (isMcpOperational(state)) {
        console.log(`[boot] Revenue wallet:   ${state.identity.address}`);
        if (isReady(state)) {
          console.log(
            `[boot] Paid tools: ${state.tools.map((t) => `${t.definition.name} (${t.definition.price})`).join(", ")}`,
          );
        } else {
          console.log("[boot] Paid tools unavailable until x402 facilitator initializes");
        }
      }
    });
  });
}

main().catch((error) => {
  console.error("Fatal startup error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
