/**
 * Settle one paid call against a production AgentWire host through the CDP
 * facilitator so the resource is indexed in the x402 Bazaar.
 *
 * Usage:
 *   SERVER_URL=https://cdp-agent-0-01.onrender.com/mcp \
 *   MCP_API_KEY=... \
 *   npx tsx scripts/production-bazaar-settle.ts
 *
 * Settles the cheapest paid surface (GET / discovery card) by default.
 * Pass --mcp peek_inbox to settle an MCP tool instead (requires inbox args).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import { toClientEvmSigner } from "@x402/evm";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import type { ClientEvmSigner } from "@x402/evm";

import {
  createCanonicalLegacyBuyer,
  createLocalEnvBuyer,
  createMainnetPaymasterBuyer,
  toX402Signer,
} from "./buyer-wallet.js";
import { createStreamableMcpTransport } from "./mcp-transport.js";

const SERVER_URL = process.env.SERVER_URL || "https://cdp-agent-0-01.onrender.com/mcp";
const BASE_URL = SERVER_URL.replace(/\/mcp$/, "");
const CAIP2_NETWORK = "eip155:8453" as const;

async function settleDiscovery(signer: ClientEvmSigner): Promise<void> {
  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: CAIP2_NETWORK, client: new ExactEvmScheme(signer) }],
    autoPayment: true,
  });

  console.log(`[settle] Paying GET ${BASE_URL}/ via CDP facilitator...`);
  const res = await fetchWithPayment(`${BASE_URL}/`);
  if (!res.ok) {
    throw new Error(`Discovery settlement failed: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  const paymentResponse = res.headers.get("payment-response");
  console.log(`[settle] Discovery OK status=${res.status} service=${body.service}`);
  console.log(`[settle] payment-response header: ${paymentResponse ? "present" : "missing"}`);
  if (!paymentResponse) {
    throw new Error("Missing payment-response header — settlement may not have completed");
  }
}

async function settleMcpTool(
  signer: ClientEvmSigner,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  const paymentClient = new x402Client().register(CAIP2_NETWORK, new ExactEvmScheme(signer));
  const mcpClient = new Client({ name: "agentwire-bazaar-settle", version: "1.0.0" });
  const x402Mcp = wrapMCPClientWithPayment(mcpClient, paymentClient, { autoPayment: true });

  await x402Mcp.connect(createStreamableMcpTransport(SERVER_URL));
  console.log(`[settle] Paying MCP tool ${toolName} via CDP facilitator...`);
  const result = await x402Mcp.callTool(toolName, args, { timeout: 180_000 });
  if (!result.paymentMade) {
    throw new Error(`MCP tool ${toolName} did not settle`);
  }
  console.log(
    `[settle] ${toolName} settled tx=${result.paymentResponse?.transaction || "(see payment-response)"}`,
  );
  await x402Mcp.close();
}

async function resolveBuyerSigner(): Promise<{ signer: ClientEvmSigner; address: string }> {
  try {
    const { ownerProvider } = await createMainnetPaymasterBuyer(5_000n);
    return { signer: toX402Signer(ownerProvider), address: ownerProvider.getAddress() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Insufficient USDC")) {
      throw error;
    }
    console.warn("[settle] Smart-wallet buyer unfunded; trying local env buyer.");
    try {
      const account = createLocalEnvBuyer();
      const publicClient = createPublicClient({ chain: base, transport: http() });
      return {
        signer: toClientEvmSigner(account, publicClient),
        address: account.address,
      };
    } catch (localError) {
      console.warn(
        `[settle] Local buyer unavailable (${localError instanceof Error ? localError.message : localError}); trying canonical legacy CDP wallet.`,
      );
      const { ownerProvider } = await createCanonicalLegacyBuyer();
      return { signer: toX402Signer(ownerProvider), address: ownerProvider.getAddress() };
    }
  }
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--mcp") ? "mcp" : "discovery";

  const { signer, address } = await resolveBuyerSigner();
  console.log(`[settle] Buyer EOA: ${address}`);
  console.log(`[settle] Target: ${BASE_URL}`);

  if (mode === "mcp") {
    const freeClient = new Client({ name: "agentwire-bazaar-free", version: "1.0.0" });
    await freeClient.connect(createStreamableMcpTransport(SERVER_URL));
    const created = await freeClient.callTool({ name: "create_inbox", arguments: {} });
    const inbox = JSON.parse((created.content as Array<{ text: string }>)[0].text) as {
      inboxId: string;
      secret: string;
    };
    await freeClient.close();
    await settleMcpTool(signer, "peek_inbox", {
      inboxId: inbox.inboxId,
      secret: inbox.secret,
    });
  } else {
    await settleDiscovery(signer);
  }

  console.log("[settle] CDP settlement complete — Bazaar indexing should follow within minutes.");
}

main().catch((error) => {
  console.error("Bazaar settlement failed:", error);
  process.exit(1);
});
