/**
 * Free smoke test (no payment needed).
 *
 * Usage: npm run smoke-test  (server must be running)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { extractPaymentRequiredFromError } from "@x402/mcp";
import { validateDiscoveryExtensionSpec } from "@x402/extensions/bazaar";

import { createStreamableMcpTransport } from "./mcp-transport.js";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:4021/mcp";
const BASE_URL = SERVER_URL.replace(/\/mcp$/, "");

async function main(): Promise<void> {
  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  await client.connect(createStreamableMcpTransport(SERVER_URL));

  console.log("=== 1. listTools ===");
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const tool of tools) {
    console.log(`- ${tool.name}`);
  }
  const expected = [
    "create_inbox",
    "drain_inbox",
    "extract_links",
    "fetch_url",
    "inbox_stats",
    "peek_inbox",
    "ping",
    "relay_post",
    "request_human_captcha_bypass",
  ];
  if (names.join(",") !== expected.join(",")) {
    throw new Error(`Expected tools [${expected.join(", ")}], got [${names.join(", ")}]`);
  }

  console.log("\n=== 2. Free tool: ping ===");
  const ping = await client.callTool({ name: "ping", arguments: {} });
  console.log((ping.content as Array<{ text: string }>)[0].text);

  console.log("\n=== 3. Free tool: create_inbox ===");
  const created = await client.callTool({ name: "create_inbox", arguments: {} });
  const inbox = JSON.parse((created.content as Array<{ text: string }>)[0].text) as {
    inboxId: string;
    secret: string;
    webhookUrl: string;
  };
  console.log(`inboxId=${inbox.inboxId}`);
  console.log(`webhookUrl=${inbox.webhookUrl}`);

  console.log("\n=== 4. POST test webhook event ===");
  const hookRes = await fetch(inbox.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "smoke_test", message: "hello agent" }),
  });
  if (!hookRes.ok) throw new Error(`Webhook POST failed: ${hookRes.status}`);
  console.log(await hookRes.json());

  console.log("\n=== 5. Unpaid drain_inbox -> expect x402 challenge ===");
  let paymentRequired: Record<string, unknown> | null = null;
  try {
    const result = await client.callTool({
      name: "drain_inbox",
      arguments: { inboxId: inbox.inboxId, secret: inbox.secret },
    });
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    if (structured && Array.isArray(structured.accepts)) {
      paymentRequired = structured;
    } else {
      const text = (result.content as Array<{ text?: string }>)?.[0]?.text;
      const parsed = text ? JSON.parse(text) : null;
      if (parsed && Array.isArray(parsed.accepts)) paymentRequired = parsed;
    }
    if (!paymentRequired) {
      throw new Error(`Paid tool returned without payment challenge: ${JSON.stringify(result)}`);
    }
  } catch (error) {
    const fromError = extractPaymentRequiredFromError(error);
    if (!fromError) throw error;
    paymentRequired = fromError as unknown as Record<string, unknown>;
  }

  const accepts = (paymentRequired.accepts as Array<Record<string, unknown>>)?.[0];
  if (!accepts) throw new Error("Missing accepts in PaymentRequired");
  console.log(`402 OK: pay ${accepts.amount} USDC base units on ${accepts.network}`);

  const resourceUrl = (paymentRequired as { resource?: { url?: string } }).resource?.url;
  if (resourceUrl !== "mcp://tool/drain_inbox") {
    throw new Error(`Unexpected resource url: ${resourceUrl}`);
  }

  const bazaar = (paymentRequired as { extensions?: Record<string, unknown> }).extensions?.bazaar;
  if (!bazaar) throw new Error("Missing bazaar discovery extension");
  const validation = validateDiscoveryExtensionSpec(bazaar as Record<string, unknown>);
  if (!validation.valid) {
    throw new Error(`Bazaar validation failed: ${JSON.stringify(validation.errors)}`);
  }
  console.log("Bazaar discovery extension OK");

  console.log("\n=== 6. Discovery endpoint -> expect x402 v2 header challenge ===");
  const card = await fetch(BASE_URL);
  if (card.status !== 402) {
    throw new Error(`Expected discovery endpoint to return 402, got ${card.status}`);
  }
  const paymentRequiredHeader = card.headers.get("payment-required");
  if (!paymentRequiredHeader) {
    throw new Error("Missing payment-required header on discovery endpoint");
  }
  const discoveryPaymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);
  const discoveryBazaar = discoveryPaymentRequired.extensions?.bazaar;
  if (!discoveryBazaar) throw new Error("Missing bazaar extension on discovery endpoint");
  const discoveryValidation = validateDiscoveryExtensionSpec(
    discoveryBazaar as Record<string, unknown>,
  );
  if (!discoveryValidation.valid) {
    throw new Error(`Discovery Bazaar validation failed: ${JSON.stringify(discoveryValidation.errors)}`);
  }
  console.log(
    `Discovery 402 OK: ${discoveryPaymentRequired.resource.url} on ${discoveryPaymentRequired.accepts[0]?.network}`,
  );

  await client.close();
  console.log("\nSMOKE TEST PASSED");
}

main().catch((error) => {
  console.error("SMOKE TEST FAILED:", error);
  process.exit(1);
});
