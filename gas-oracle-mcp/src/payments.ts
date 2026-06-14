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
import { createAuthHeader, createCorrelationHeader } from "@coinbase/x402";
import {
  type FacilitatorClient,
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

import { CONFIG } from "./config.js";
import { resolveCdpCredentials } from "./wallet.js";

const CDP_X402_PLATFORM_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

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
  tagline: "Webhook inbox + web fetch for autonomous agents",
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
    { name: "fetch_url", price: CONFIG.prices.fetchUrl },
    { name: "ping", price: "free" },
  ],
} as const;

/** Creates the facilitator client, attaching CDP auth headers on mainnet. */
function createFacilitatorClient(): FacilitatorClient {
  if (CONFIG.usesCdpFacilitator) {
    const facilitatorClient = new HTTPFacilitatorClient(createCdpFacilitatorConfig(CONFIG.facilitatorUrl));
    const supportedClient = new HTTPFacilitatorClient(createCdpFacilitatorConfig(CDP_X402_PLATFORM_URL));

    return {
      verify: (paymentPayload, paymentRequirements) =>
        facilitatorClient.verify(paymentPayload, paymentRequirements),
      settle: (paymentPayload, paymentRequirements) =>
        facilitatorClient.settle(paymentPayload, paymentRequirements),
      getSupported: () => supportedClient.getSupported(),
    };
  }
  return new HTTPFacilitatorClient({ url: CONFIG.facilitatorUrl });
}

export function createCdpFacilitatorConfig(url: string): FacilitatorConfig {
  let credentials: ReturnType<typeof resolveCdpCredentials> | undefined;

  if (CONFIG.payToOverride) {
    console.log("[x402] PAY_TO_ADDRESS set; skipping CDP facilitator auth headers.");
  } else {
    try {
      credentials = resolveCdpCredentials();
    } catch (error) {
      console.warn(
        `[x402] CDP facilitator auth unavailable until credentials are configured: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const facilitatorUrl = new URL(url);
  const requestHost = facilitatorUrl.host;
  const route = facilitatorUrl.pathname.replace(/\/$/, "");

  return {
    url,
    createAuthHeaders: async () => {
      const correlationHeaders = {
        "Correlation-Context": createCorrelationHeader(),
      };
      const headers = {
        verify: { ...correlationHeaders },
        settle: { ...correlationHeaders },
        supported: { ...correlationHeaders },
        bazaar: { ...correlationHeaders },
      };

      if (credentials) {
        try {
          return {
            verify: {
              ...headers.verify,
              Authorization: await createAuthHeader(
                credentials.apiKeyId,
                credentials.apiKeySecret,
                "POST",
                requestHost,
                `${route}/verify`,
              ),
            },
            settle: {
              ...headers.settle,
              Authorization: await createAuthHeader(
                credentials.apiKeyId,
                credentials.apiKeySecret,
                "POST",
                requestHost,
                `${route}/settle`,
              ),
            },
            supported: {
              ...headers.supported,
              Authorization: await createAuthHeader(
                credentials.apiKeyId,
                credentials.apiKeySecret,
                "GET",
                requestHost,
                `${route}/supported`,
              ),
            },
            bazaar: headers.bazaar,
          };
        } catch (error) {
          console.warn(
            `[x402] CDP facilitator auth disabled for this request: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      return headers;
    },
  };
}

/**
 * Builds and initializes the x402 resource server for our payment network,
 * with the "exact" EVM scheme (EIP-3009 USDC transfers) and Bazaar discovery.
 */
export async function createResourceServer(): Promise<x402ResourceServer> {
  const facilitatorClient = createFacilitatorClient();

  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(CONFIG.caip2Network, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);

  // Fetches supported schemes/networks from the facilitator.
  await resourceServer.initialize();

  console.log(`[x402] Facilitator: ${CONFIG.facilitatorUrl}`);
  console.log(`[x402] Payment network: ${CONFIG.caip2Network} (${CONFIG.network})`);
  return resourceServer;
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
      description: "AgentWire service card for webhook inbox relay and web fetch infrastructure.",
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
