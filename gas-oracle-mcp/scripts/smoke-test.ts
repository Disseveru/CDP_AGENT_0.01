/**
 * Free smoke test (no payment needed).
 *
 * Verifies tool listing, free ping, and x402 challenge on unpaid paid-tool calls.
 *
 * Usage: npm run smoke-test  (server must be running)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { extractPaymentRequiredFromError } from "@x402/mcp";
import { validateDiscoveryExtensionSpec } from "@x402/extensions/bazaar";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:4021/mcp";

async function main(): Promise<void> {
  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(SERVER_URL)));

  console.log("=== 1. listTools ===");
  const { tools } = await client.listTools();
  for (const tool of tools) {
    console.log(`- ${tool.name}: inputSchema=${JSON.stringify(tool.inputSchema)}`);
  }
  if (tools.length !== 3) throw new Error(`Expected 3 tools, got ${tools.length}`);

  console.log("\n=== 2. Free tool: ping ===");
  const ping = await client.callTool({ name: "ping", arguments: {} });
  console.log((ping.content as Array<{ text: string }>)[0].text);

  console.log("\n=== 3. Unpaid call to paid tool -> expect x402 challenge ===");
  let paymentRequired: Record<string, unknown> | null = null;
  try {
    const result = await client.callTool({
      name: "simulate_transaction",
      arguments: {
        chain: "base-sepolia",
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        data: "0x",
        value: "0",
      },
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
      throw new Error(`Paid tool returned a payload without payment: ${JSON.stringify(result)}`);
    }
  } catch (error) {
    const fromError = extractPaymentRequiredFromError(error);
    if (!fromError) throw error;
    paymentRequired = fromError as unknown as Record<string, unknown>;
  }

  {
    console.log("PaymentRequired envelope received:");
    console.log(JSON.stringify(paymentRequired, null, 2));

    const accepts = (paymentRequired.accepts as Array<Record<string, unknown>>)?.[0];
    if (!accepts) throw new Error("Missing accepts in PaymentRequired");
    console.log(
      `\n402 OK: pay ${accepts.amount} of asset ${accepts.asset} on ${accepts.network} to ${accepts.payTo}`,
    );

    const resourceUrl = (paymentRequired as { resource?: { url?: string } }).resource?.url;
    if (resourceUrl !== "mcp://tool/simulate_transaction") {
      throw new Error(`Unexpected resource url: ${resourceUrl}`);
    }
    console.log(`Resource URL OK: ${resourceUrl}`);

    const bazaar = (paymentRequired as { extensions?: Record<string, unknown> }).extensions?.bazaar;
    if (!bazaar) throw new Error("Missing bazaar discovery extension in 402 response");
    const validation = validateDiscoveryExtensionSpec(bazaar as Record<string, unknown>);
    if (!validation.valid) {
      throw new Error(`Bazaar extension failed strict validation: ${JSON.stringify(validation.errors)}`);
    }
    console.log("Bazaar discovery extension passed strict spec validation.");
  }

  await client.close();
  console.log("\nSMOKE TEST PASSED");
}

main().catch((error) => {
  console.error("SMOKE TEST FAILED:", error);
  process.exit(1);
});
