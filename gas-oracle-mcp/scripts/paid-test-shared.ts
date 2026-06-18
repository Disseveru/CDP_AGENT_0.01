import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import type { PrivateKeyAccount } from "viem/accounts";
import type { ClientEvmSigner } from "@x402/evm";

import { createStreamableMcpTransport } from "./mcp-transport.js";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:4021/mcp";
const BASE_URL = SERVER_URL.replace(/\/mcp$/, "");

export interface PaidTestContext {
  caip2Network: `eip155:${number}`;
  explorerBase: string;
}

export interface PaidToolResult {
  toolName: string;
  paymentMade: boolean;
  settlementTx?: string;
  body: string;
}

function createPaidMcpClient(signer: PrivateKeyAccount | ClientEvmSigner, caip2Network: `eip155:${number}`) {
  const paymentClient = new x402Client().register(caip2Network, new ExactEvmScheme(signer));
  const mcpClient = new Client({ name: "agentwire-buyer-paid", version: "1.0.0" });
  const x402Mcp = wrapMCPClientWithPayment(mcpClient, paymentClient, {
    autoPayment: true,
    onPaymentRequested: ({ toolName, paymentRequired }) => {
      const accepts = paymentRequired.accepts[0];
      console.log(`[buyer] 402 for ${toolName}: paying ${accepts.amount} base units`);
      return true;
    },
  });
  return x402Mcp;
}

async function callPaidTool(
  x402Mcp: ReturnType<typeof createPaidMcpClient>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<PaidToolResult> {
  const result = await x402Mcp.callTool(toolName, args, { timeout: 180_000 });
  const body = (result.content[0] as { text: string }).text;
  return {
    toolName,
    paymentMade: Boolean(result.paymentMade),
    settlementTx: result.paymentResponse?.transaction,
    body,
  };
}

function assertPaid(result: PaidToolResult): void {
  if (!result.paymentMade || !result.settlementTx) {
    throw new Error(`Payment for ${result.toolName} did not settle`);
  }
}

export async function runAllPaidEndpointTests(
  signer: PrivateKeyAccount | ClientEvmSigner,
  context: PaidTestContext,
): Promise<PaidToolResult[]> {
  const freeClient = new Client({ name: "agentwire-buyer", version: "1.0.0" });
  await freeClient.connect(createStreamableMcpTransport(SERVER_URL));

  console.log("\n=== Step 1: create_inbox (free) ===");
  const created = await freeClient.callTool({ name: "create_inbox", arguments: {} });
  const inbox = JSON.parse((created.content as Array<{ text: string }>)[0].text) as {
    inboxId: string;
    secret: string;
    webhookUrl: string;
  };
  console.log(`webhookUrl=${inbox.webhookUrl}`);

  console.log("\n=== Step 2: external webhook POST ===");
  const hookRes = await fetch(inbox.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-Source": "paid-client-test" },
    body: JSON.stringify({
      type: "order.completed",
      orderId: "ord_123",
      amount: 49.99,
    }),
  });
  if (!hookRes.ok) throw new Error(`Webhook failed: ${hookRes.status}`);
  console.log(await hookRes.json());

  const x402Mcp = createPaidMcpClient(signer, context.caip2Network);
  await x402Mcp.connect(createStreamableMcpTransport(SERVER_URL));

  const results: PaidToolResult[] = [];

  console.log("\n=== Step 3: peek_inbox (paid) ===");
  const peeked = await callPaidTool(x402Mcp, "peek_inbox", {
    inboxId: inbox.inboxId,
    secret: inbox.secret,
  });
  console.log(`paymentMade=${peeked.paymentMade} settlementTx=${peeked.settlementTx}`);
  console.log(peeked.body);
  assertPaid(peeked);
  const peekBody = JSON.parse(peeked.body) as { events?: unknown[] };
  if (!peekBody.events?.length) throw new Error("Expected peek_inbox to return events");
  results.push(peeked);

  console.log("\n=== Step 4: drain_inbox (paid) ===");
  const drained = await callPaidTool(x402Mcp, "drain_inbox", {
    inboxId: inbox.inboxId,
    secret: inbox.secret,
  });
  console.log(`paymentMade=${drained.paymentMade} settlementTx=${drained.settlementTx}`);
  console.log(drained.body);
  assertPaid(drained);
  const drainBody = JSON.parse(drained.body) as { drained: number };
  if (drainBody.drained < 1) throw new Error("Expected at least one drained event");
  results.push(drained);

  console.log("\n=== Step 5: fetch_url (paid) ===");
  const fetched = await callPaidTool(x402Mcp, "fetch_url", { url: "https://example.com" });
  console.log(`paymentMade=${fetched.paymentMade} settlementTx=${fetched.settlementTx}`);
  console.log(fetched.body);
  assertPaid(fetched);
  const fetchBody = JSON.parse(fetched.body) as { status: number };
  if (fetchBody.status !== 200) throw new Error(`fetch_url expected status 200, got ${fetchBody.status}`);
  results.push(fetched);

  console.log("\n=== Step 6: discovery endpoint GET / (paid) ===");
  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: context.caip2Network, client: new ExactEvmScheme(signer) }],
    autoPayment: true,
  });
  const discoveryRes = await fetchWithPayment(BASE_URL);
  if (!discoveryRes.ok) {
    throw new Error(`Discovery endpoint failed: ${discoveryRes.status} ${await discoveryRes.text()}`);
  }
  const discoveryBody = await discoveryRes.json();
  if (discoveryBody.service !== "AgentWire") {
    throw new Error(`Unexpected discovery payload: ${JSON.stringify(discoveryBody)}`);
  }
  const paymentResponse = discoveryRes.headers.get("payment-response");
  console.log(`discovery status=${discoveryRes.status} payment-response=${paymentResponse ? "present" : "missing"}`);
  console.log(JSON.stringify(discoveryBody, null, 2));
  if (!paymentResponse) {
    throw new Error("Discovery endpoint did not return payment-response header");
  }
  results.push({
    toolName: "discovery",
    paymentMade: true,
    settlementTx: undefined,
    body: JSON.stringify(discoveryBody),
  });

  await freeClient.close();
  await x402Mcp.close();

  return results;
}

export function printSettlementSummary(results: PaidToolResult[], explorerBase: string): void {
  console.log(`\nPAID E2E TEST PASSED - ${results.length} paid endpoint(s):`);
  for (const [index, result] of results.entries()) {
    if (result.settlementTx) {
      console.log(`  ${index + 1}. ${result.toolName}: ${explorerBase}/tx/${result.settlementTx}`);
    } else {
      console.log(`  ${index + 1}. ${result.toolName}: settled (see payment-response header)`);
    }
  }
}
