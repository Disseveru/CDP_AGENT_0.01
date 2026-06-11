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
import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
  validateDiscoveryExtensionSpec,
} from "@x402/extensions/bazaar";

import { CONFIG } from "./config.js";
import { resolveCdpCredentials } from "./wallet.js";

/** Creates the facilitator client, attaching CDP auth headers on mainnet. */
function createFacilitatorClient(): HTTPFacilitatorClient {
  if (CONFIG.usesCdpFacilitator) {
    const credentials = resolveCdpCredentials();
    const facilitatorConfig = createFacilitatorConfig(
      credentials.apiKeyId,
      credentials.apiKeySecret,
    );
    return new HTTPFacilitatorClient(facilitatorConfig);
  }
  return new HTTPFacilitatorClient({ url: CONFIG.facilitatorUrl });
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
