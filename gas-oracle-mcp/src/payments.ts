/**
 * x402 payment rail.
 *
 * Builds the x402ResourceServer that verifies and settles USDC payments via
 * a facilitator, and registers the Bazaar discovery extension so the CDP
 * Facilitator can auto-catalog this service in Agentic.Market / x402 Bazaar.
 *
 * Settlement note: under x402 v2 every payment payload the client signs and
 * this server forwards to the facilitator's /settle endpoint carries
 * `paymentPayload.resource` (the mcp://tool/... URL from the 402 challenge).
 * The CDP Facilitator uses that field to associate the settlement with the
 * resource and index it in the Bazaar automatically.
 */
import { createFacilitatorConfig, facilitator as defaultCdpFacilitator } from "@coinbase/x402";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import type { FacilitatorConfig, RouteConfig } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
  validateBazaarRouteExtensions,
  validateDiscoveryExtensionSpec,
} from "@x402/extensions/bazaar";

import { CONFIG, DEFAULT_PERMISSIONLESS_FACILITATOR } from "./config.js";
import { resolveCdpApiCredentials } from "./wallet.js";

const SERVICE_CARD_OUTPUT_SCHEMA = {
  properties: {
    service: { type: "string" },
    version: { type: "string" },
    status: { type: "string" },
    tagline: { type: "string" },
    protocol: { type: "string" },
    endpoint: { type: "string" },
    webhooks: { type: "string" },
    paymentNetwork: { type: "string" },
    facilitator: { type: "string" },
    payTo: { type: "string" },
    tools: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          price: { type: "string" },
        },
        required: ["name", "price"],
      },
    },
  },
  required: [
    "service",
    "version",
    "status",
    "tagline",
    "protocol",
    "endpoint",
    "webhooks",
    "paymentNetwork",
    "facilitator",
    "payTo",
    "tools",
  ],
} as const;

export const SERVICE_CARD_OUTPUT_EXAMPLE = {
  service: CONFIG.serviceName,
  version: CONFIG.serviceVersion,
  status: "ready",
  tagline: "Webhook inbox + web fetch + outbound relay for autonomous agents",
  protocol: "MCP over Streamable HTTP + x402 v2 payments",
  endpoint: `${CONFIG.publicUrl}/mcp`,
  webhooks: `${CONFIG.publicUrl}/hooks/{inboxId}`,
  paymentNetwork: CONFIG.caip2Network,
  facilitator: CONFIG.facilitatorUrl,
  payTo: "0x0000000000000000000000000000000000000000",
  tools: [
    { name: "create_inbox", price: "free" },
    { name: "drain_inbox", price: CONFIG.prices.drainInbox },
    { name: "peek_inbox", price: CONFIG.prices.peekInbox },
    { name: "inbox_stats", price: CONFIG.prices.inboxStats },
    { name: "fetch_url", price: CONFIG.prices.fetchUrl },
    { name: "extract_links", price: CONFIG.prices.extractLinks },
    { name: "relay_post", price: CONFIG.prices.relayPost },
    { name: "ping", price: "free" },
  ],
} as const;

/**
 * Builds the CDP facilitator config from the official @coinbase/x402 package,
 * matching the CDP sellers quickstart "Running on Mainnet" section.
 */
export function createCdpFacilitatorConfig(): FacilitatorConfig {
  const credentials = resolveCdpApiCredentials();
  if (credentials) {
    return createFacilitatorConfig(credentials.apiKeyId, credentials.apiKeySecret);
  }

  if (CONFIG.usesCdpFacilitator) {
    console.warn(
      "[x402] CDP facilitator auth unavailable until CDP_API_KEY (or CDP_API_KEY_ID) and " +
        "CDP_PRIVATE_KEY (or CDP_API_KEY_SECRET) are configured.",
    );
  }

  return defaultCdpFacilitator;
}

/** Creates the facilitator client for verify/settle operations. */
function createFacilitatorClient(): HTTPFacilitatorClient {
  if (CONFIG.usesCdpFacilitator) {
    return new HTTPFacilitatorClient(createCdpFacilitatorConfig());
  }
  return new HTTPFacilitatorClient({ url: CONFIG.facilitatorUrl });
}

function buildResourceServer(facilitatorClient: HTTPFacilitatorClient): x402ResourceServer {
  return new x402ResourceServer(facilitatorClient)
    .register(CONFIG.caip2Network, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
}

async function initializeResourceServer(
  facilitatorUrl: string,
  facilitatorClient: HTTPFacilitatorClient,
): Promise<x402ResourceServer> {
  const resourceServer = buildResourceServer(facilitatorClient);
  await resourceServer.initialize();
  console.log(`[x402] Facilitator: ${facilitatorUrl}`);
  console.log(`[x402] Payment network: ${CONFIG.caip2Network} (${CONFIG.network})`);
  return resourceServer;
}

/**
 * Builds and initializes the x402 resource server for our payment network,
 * with the "exact" EVM scheme (EIP-3009 USDC transfers) and Bazaar discovery.
 *
 * When the primary CDP facilitator cannot load supported payment kinds, falls
 * back to the permissionless facilitator so paid tools can still initialize.
 */
export async function createResourceServer(): Promise<x402ResourceServer> {
  const primaryClient = createFacilitatorClient();

  try {
    return await initializeResourceServer(CONFIG.facilitatorUrl, primaryClient);
  } catch (primaryError) {
    const canFallback =
      CONFIG.usesCdpFacilitator && CONFIG.facilitatorUrl !== DEFAULT_PERMISSIONLESS_FACILITATOR;
    if (!canFallback) {
      throw primaryError;
    }

    console.warn(
      `[x402] Primary facilitator failed (${primaryError instanceof Error ? primaryError.message : String(primaryError)}); ` +
        `retrying with ${DEFAULT_PERMISSIONLESS_FACILITATOR}`,
    );

    const fallbackClient = new HTTPFacilitatorClient({ url: DEFAULT_PERMISSIONLESS_FACILITATOR });
    return initializeResourceServer(DEFAULT_PERMISSIONLESS_FACILITATOR, fallbackClient);
  }
}

/**
 * Builds the `accepts` payment requirements for one paid tool.
 */
export async function buildAccepts(
  resourceServer: x402ResourceServer,
  payTo: string,
  price: string,
): Promise<PaymentRequirements[]> {
  return resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network: CONFIG.caip2Network,
    payTo,
    price,
    maxTimeoutSeconds: 120,
  });
}

function rootResourceUrl(): string {
  return `${CONFIG.publicUrl.replace(/\/$/, "")}/`;
}

export function buildDiscoveryRouteConfig(payTo: string): RouteConfig {
  const extensions = declareDiscoveryExtension({
    input: {},
    inputSchema: {
      properties: {},
      additionalProperties: false,
    },
    output: {
      example: { ...SERVICE_CARD_OUTPUT_EXAMPLE, payTo },
      schema: SERVICE_CARD_OUTPUT_SCHEMA,
    },
  });

  const routes = {
    "GET /": {
      accepts: {
        scheme: "exact",
        network: CONFIG.caip2Network,
        payTo,
        price: CONFIG.prices.discovery,
        maxTimeoutSeconds: 300,
      },
      resource: rootResourceUrl(),
      description: "AgentWire service card for webhook inbox relay, web fetch, and outbound HTTP relay.",
      mimeType: "application/json",
      serviceName: CONFIG.serviceName,
      tags: ["webhook", "inbox", "fetch", "agent-infrastructure", "relay"],
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: {},
      }),
      extensions,
    },
  } satisfies Record<string, RouteConfig>;

  validateBazaarRouteExtensions(routes);
  return routes["GET /"];
}

export async function createDiscoveryHttpServer(
  resourceServer: x402ResourceServer,
  payTo: string,
): Promise<x402HTTPResourceServer> {
  const httpServer = new x402HTTPResourceServer(resourceServer, {
    "GET /": buildDiscoveryRouteConfig(payTo),
  });

  await httpServer.initialize();
  return httpServer;
}

export interface ToolDiscoveryMetadata {
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  example?: Record<string, unknown>;
  outputExample?: unknown;
}

/**
 * Builds Bazaar v2 discovery extensions for an MCP tool and validates them
 * against the strict protocol-level JSON schema before the server boots.
 */
export function buildDiscoveryExtension(meta: ToolDiscoveryMetadata): Record<string, unknown> {
  const extensions = declareDiscoveryExtension({
    toolName: meta.toolName,
    description: meta.description,
    transport: "streamable-http",
    inputSchema: meta.inputSchema,
    example: meta.example,
    output: meta.outputExample !== undefined ? { example: meta.outputExample } : undefined,
  });

  const validation = validateDiscoveryExtensionSpec(
    (extensions as unknown as { bazaar: Record<string, unknown> }).bazaar,
  );
  if (!validation.valid) {
    throw new Error(
      `Bazaar discovery extension for "${meta.toolName}" failed strict schema validation: ${JSON.stringify(validation.errors)}`,
    );
  }
  console.log(`[bazaar] Discovery extension for "${meta.toolName}" passed strict schema validation`);

  return extensions;
}
