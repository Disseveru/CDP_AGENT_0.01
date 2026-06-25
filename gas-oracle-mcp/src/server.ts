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
import {
  completeCaptchaTask,
  createCaptchaTask,
  getCaptchaStatus,
  parseSubmitBody,
  waitForCaptchaSolution,
} from "./captcha/tasks.js";
import { deleteCaptchaTask, getCaptchaTask, isCaptchaStorageConfigured } from "./captcha/store.js";
import { notifyOperator } from "./captcha/notifications.js";
import { renderSolvePage } from "./captcha/solve-page.js";
import { renderOperatorSmsConsentPage } from "./captcha/operator-sms-consent-page.js";
import { safeCompareSecret } from "./captcha/tokens.js";
import { fetchUrl } from "./fetch.js";
import { createInbox, getInboxStats, peekInbox } from "./inbox.js";
import { extractLinks } from "./links.js";
import { relayPost } from "./relay.js";
import { appendEvent, inboxExists, initializeStorage, removeInboxEventsByIds, getStorageHealth } from "./store.js";
import {
  acquireInboxDrainLock,
  allowRateLimitedRequest,
  allowWebhookRequest,
  getRedisHealth,
  isRedisEnabled,
  releaseInboxDrainLock,
} from "./redis.js";
import { runMigrations } from "./migrate.js";
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
      const peeked = await peekInbox({ inboxId: String(args.inboxId), secret: String(args.secret) });
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
      await peekInbox({ inboxId: String(args.inboxId), secret: String(args.secret) }),
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
      await getInboxStats({ inboxId: String(args.inboxId), secret: String(args.secret) }),
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
  {
    name: "request_human_captcha_bypass",
    description:
      `Queue a CAPTCHA barrier for human-in-the-loop solving. Instantly SMS + emails the operator ` +
      `with a mobile solve link on ${CONFIG.publicUrl}/solve/{task_id}, then blocks until the ` +
      `solution token is ready. Supports reCAPTCHA, hCaptcha, and Turnstile. ` +
      `Costs ${CONFIG.prices.captchaBypass} USDC per call.`,
    price: CONFIG.prices.captchaBypass,
    zodShape: {
      sitekey: z.string().describe("CAPTCHA site key from the target page"),
      pageurl: z.string().url().describe("URL of the page showing the CAPTCHA"),
      captcha_type: z
        .enum(["recaptcha", "hcaptcha", "turnstile"])
        .describe("CAPTCHA provider type"),
    },
    jsonSchema: {
      type: "object",
      properties: {
        sitekey: { type: "string" },
        pageurl: { type: "string", format: "uri" },
        captcha_type: { type: "string", enum: ["recaptcha", "hcaptcha", "turnstile"] },
      },
      required: ["sitekey", "pageurl", "captcha_type"],
    },
    example: {
      sitekey: "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI",
      pageurl: "https://example.com/login",
      captcha_type: "recaptcha",
    },
    outputExample: {
      task_id: "550e8400-e29b-41d4-a716-446655440000",
      status: "completed",
      solution_token: "03AGdBq24...",
      solve_url: `${CONFIG.publicUrl}/solve/550e8400-e29b-41d4-a716-446655440000`,
    },
    handler: async (args) => {
      if (!isCaptchaStorageConfigured()) {
        throw new Error("CAPTCHA storage unavailable: REDIS_URL must be configured on Railway");
      }
      const created = await createCaptchaTask({
        sitekey: String(args.sitekey),
        pageurl: String(args.pageurl),
        captcha_type: args.captcha_type as "recaptcha" | "hcaptcha" | "turnstile",
      });
      const solved = await waitForCaptchaSolution(created.task_id, created.poll_token);
      return {
        task_id: solved.task_id,
        status: solved.status,
        solution_token: solved.solution_token,
        solve_url: created.solve_url,
        poll_token: created.poll_token,
        completed_at: solved.completed_at,
      };
    },
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
    tagline: "Webhook inbox + web fetch + outbound relay + human CAPTCHA bypass for autonomous agents",
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

async function handleCaptchaSubmitRequest(
  req: Request,
  res: Response,
  state: RuntimeState,
): Promise<void> {
  if (!isReady(state)) {
    res.status(503).json({ error: "Payments unavailable", status: state.status });
    return;
  }

  if (!isCaptchaStorageConfigured()) {
    res.status(503).json({
      error: "captcha_storage_unavailable",
      message: "CAPTCHA task storage requires REDIS_URL on Railway",
    });
    return;
  }

  let input;
  try {
    input = parseSubmitBody(req.body);
  } catch (error) {
    res.status(400).json({
      error: "invalid_request",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const requestContext: HTTPRequestContext = {
    adapter: createExpressHttpAdapter(req),
    path: req.path,
    method: req.method,
    paymentHeader: req.get("payment-signature") || req.get("x-payment"),
  };
  const paymentResult = await state.discoveryHttpServer.processHTTPRequest(requestContext);

  if (paymentResult.type === "payment-error") {
    writeHttpInstructions(res, paymentResult.response);
    return;
  }

  if (paymentResult.type !== "payment-verified") {
    res.status(500).json({ error: "unexpected_payment_state" });
    return;
  }

  let created;
  try {
    created = await createCaptchaTask(input, { notify: false });
  } catch (error) {
    console.error("[captcha] Task creation failed after payment verification:", error);
    res.status(503).json({
      error: "captcha_task_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const body = created;
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
    await deleteCaptchaTask(created.task_id).catch((error) => {
      console.error("[captcha] Failed to roll back task after settlement failure:", error);
    });
    writeHttpInstructions(res, settlement.response);
    return;
  }

  void notifyOperator({
    taskId: created.task_id,
    solveUrl: created.solve_url,
    captchaType: input.captcha_type,
    pageUrl: input.pageurl,
  }).catch((error) => {
    console.error("[captcha] Operator alert failed:", error);
  });

  for (const [name, value] of Object.entries(settlement.headers)) {
    res.setHeader(name, value);
  }
  res.status(201).json(body);
}

interface PendingDrainAck {
  inboxId: string;
  secret: string;
  eventIds: string[];
  releaseDrainLock: boolean;
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
  /** MCP CAPTCHA tasks rolled back when x402 settlement fails after the handler returns. */
  const pendingCaptchaTasks = new Map<string, string>();

  if (isReady(state)) {
    for (const { definition, accepts, extensions } of state.tools) {
      const paid = createPaymentWrapper(state.resourceServer, {
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
          onAfterSettlement: async ({ paymentPayload, settlement }) => {
            const paymentKey = paymentKeyFromPayload(paymentPayload);
            const pending = pendingDrainAcks.get(paymentKey);
            if (pending) {
              try {
                if (settlement.success) {
                  await removeInboxEventsByIds(pending.inboxId, pending.secret, pending.eventIds);
                }
              } finally {
                if (pending.releaseDrainLock) {
                  await releaseInboxDrainLock(pending.inboxId);
                }
                pendingDrainAcks.delete(paymentKey);
              }
            }

            const captchaTaskId = pendingCaptchaTasks.get(paymentKey);
            if (captchaTaskId) {
              if (!settlement.success) {
                await deleteCaptchaTask(captchaTaskId).catch((error) => {
                  console.error(
                    "[captcha] Failed to roll back MCP task after settlement failure:",
                    error,
                  );
                });
              }
              pendingCaptchaTasks.delete(paymentKey);
            }

            console.log(`[x402] Settled ${definition.name} tx=${settlement.transaction}`);
          },
        },
      });

      const paidHandler = paid(async (args, context) => {
        if (definition.name === "drain_inbox") {
          const inboxId = String(args.inboxId);
          const acquired = await acquireInboxDrainLock(inboxId, 120);
          if (!acquired) {
            throw new Error(`Inbox ${inboxId} drain already in progress; retry shortly`);
          }
        }

        const toolResult = await definition.handler(args);
        const paymentKey = paymentKeyFromMeta(context?.meta);

        if (definition.name === "drain_inbox") {
          const events = (toolResult as { events?: { id: string }[] }).events ?? [];
          if (paymentKey) {
            pendingDrainAcks.set(paymentKey, {
              inboxId: String(args.inboxId),
              secret: String(args.secret),
              eventIds: events.map((event) => event.id),
              releaseDrainLock: true,
            });
          } else {
            await releaseInboxDrainLock(String(args.inboxId));
          }
        }

        if (definition.name === "request_human_captcha_bypass" && paymentKey) {
          const taskId = (toolResult as { task_id?: string }).task_id;
          if (taskId) {
            pendingCaptchaTasks.set(paymentKey, taskId);
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
      content: [{ type: "text" as const, text: JSON.stringify(await createInbox(), null, 2) }],
    }),
  );

  const paidTools = isReady(state)
    ? state.tools.map((t) => ({ name: t.definition.name, price: t.definition.price }))
    : TOOL_DEFINITIONS.map((t) => ({ name: t.name, price: t.price }));

  mcpServer.tool("ping", "Free health check. Returns service status and pricing.", {}, async () => {
    const [storage, redis] = await Promise.all([getStorageHealth(), getRedisHealth()]);
    return {
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
            storage,
            redis: isRedisEnabled() ? redis : { ok: false, detail: "disabled" },
            error: state.error,
          }),
        },
      ],
    };
  });

  return mcpServer;
}

/** Active SSE sessions keyed by sessionId (Cursor IDE and other HTTP+SSE clients). */
const sseTransports = new Map<string, SSEServerTransport>();

function isAuthorizedMcpRequest(req: Request): boolean {
  if (!CONFIG.mcpApiKey) {
    return process.env.RAILWAY_ENVIRONMENT !== "production";
  }

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

async function allowCaptchaRequest(req: Request): Promise<boolean> {
  const clientIp = req.ip || "unknown";
  return allowRateLimitedRequest(
    "captcha",
    clientIp,
    CONFIG.captchaRateLimit,
    CONFIG.captchaRateWindowSec,
  );
}

async function main(): Promise<void> {
  console.log(`[boot] ${CONFIG.serviceName} v${CONFIG.serviceVersion} starting...`);

  if (CONFIG.databaseUrl) {
    await runMigrations();
  }
  await initializeStorage();
  if (isRedisEnabled()) {
    const redisHealth = await getRedisHealth();
    console.log(`[boot] Redis: ${redisHealth.ok ? "connected" : redisHealth.detail || "unavailable"}`);
  }

  const app = express();
  const state: RuntimeState = { status: "starting" };

  // Railway terminates TLS and proxies requests; needed for correct host/proto on SSE POSTs.
  app.set("trust proxy", 1);

  app.use(express.json({ limit: "1mb" }));
  app.use(express.text({ type: ["text/*", "application/xml"], limit: "1mb" }));

  // Inbound webhook relay — external services POST here, agents drain via MCP.
  app.all("/hooks/:inboxId", async (req, res) => {
    const { inboxId } = req.params;
    const clientIp = req.ip || "unknown";

    // Rate-limit by client IP before storage lookups. A per-inbox key would assign
    // each random inboxId its own bucket and allow unbounded 404 probes against Postgres.
    const allowed = await allowWebhookRequest(
      clientIp,
      CONFIG.webhookRateLimit,
      CONFIG.webhookRateWindowSec,
    );
    if (!allowed) {
      res.status(429).json({ error: "Rate limit exceeded" });
      return;
    }

    if (!(await inboxExists(inboxId))) {
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

      const event = await appendEvent(inboxId, {
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

  app.post("/api/v1/captcha/submit", async (req, res, next) => {
    if (!(await allowCaptchaRequest(req))) {
      res.status(429).json({ error: "Rate limit exceeded" });
      return;
    }
    handleCaptchaSubmitRequest(req, res, state).catch(next);
  });

  // Status polling is authenticated via poll_token (256-bit secret). Do not apply
  // the shared captcha IP rate limit here — at 2s intervals a 30/min cap blocks
  // legitimate waits before CAPTCHA_POLL_TIMEOUT_MS (default 5 minutes).
  app.get("/api/v1/captcha/status", async (req, res) => {
    const taskId = req.query.task_id;
    const pollToken = req.query.poll_token;
    if (typeof taskId !== "string" || !taskId) {
      res.status(400).json({ error: "task_id query parameter required" });
      return;
    }
    if (typeof pollToken !== "string" || !pollToken) {
      res.status(400).json({ error: "poll_token query parameter required" });
      return;
    }

    const status = await getCaptchaStatus(taskId, pollToken);
    if (!status) {
      res.status(404).json({ error: "task_not_found" });
      return;
    }
    res.json(status);
  });

  app.get("/solve/:taskId", async (req, res) => {
    if (!(await allowCaptchaRequest(req))) {
      res.status(429).send("Rate limit exceeded");
      return;
    }

    const solveToken =
      typeof req.query.token === "string"
        ? req.query.token
        : typeof req.query.solve_token === "string"
          ? req.query.solve_token
          : "";
    const task = await getCaptchaTask(req.params.taskId);
    if (!task || !solveToken) {
      res.status(404).send("Task not found");
      return;
    }

    if (!safeCompareSecret(solveToken, task.solve_token)) {
      res.status(404).send("Task not found");
      return;
    }

    if (task.status === "completed") {
      res.status(200).send("<p>Already solved. Agent can poll /api/v1/captcha/status.</p>");
      return;
    }
    res.type("html").send(renderSolvePage(task, solveToken));
  });

  app.get("/operator-sms-consent", (_req, res) => {
    const { notifications } = CONFIG.captcha;
    res.type("html").send(
      renderOperatorSmsConsentPage({
        serviceName: CONFIG.serviceName,
        publicUrl: CONFIG.publicUrl,
        operatorSmsNumber: notifications.operatorSmsNumber,
        operatorEmail: notifications.operatorEmail,
      }),
    );
  });

  app.post("/api/v1/captcha/solve/:taskId", async (req, res) => {
    if (!(await allowCaptchaRequest(req))) {
      res.status(429).json({ error: "Rate limit exceeded" });
      return;
    }

    const solutionToken =
      typeof req.body?.solution_token === "string" ? req.body.solution_token.trim() : "";
    const solveToken =
      typeof req.body?.solve_token === "string"
        ? req.body.solve_token.trim()
        : typeof req.query.token === "string"
          ? req.query.token
          : "";
    if (!solutionToken || !solveToken) {
      res.status(400).json({ error: "solution_token and solve_token required" });
      return;
    }
    const updated = await completeCaptchaTask(req.params.taskId, solutionToken, solveToken);
    if (!updated) {
      res.status(404).json({ error: "task_not_found" });
      return;
    }
    res.json({
      task_id: updated.task_id,
      status: updated.status,
      completed_at: updated.completed_at,
    });
  });

  app.get("/health", async (_req, res) => {
    const [storage, redis] = await Promise.all([getStorageHealth(), getRedisHealth()]);
    res.json({
      status: "ok",
      service: CONFIG.serviceName,
      runtimeStatus: state.status,
      payTo: state.identity?.address,
      network: CONFIG.caip2Network,
      storage,
      redis: isRedisEnabled() ? redis : { ok: false, detail: "disabled" },
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
    console.log(`[boot] CAPTCHA submit:   ${CONFIG.publicUrl}/api/v1/captcha/submit`);
    console.log(`[boot] CAPTCHA solve:    ${CONFIG.publicUrl}/solve/{task_id}`);
    console.log(`[boot] SMS consent page: ${CONFIG.publicUrl}/operator-sms-consent`);
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
