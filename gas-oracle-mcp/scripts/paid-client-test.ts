/**
 * Full end-to-end paid test on Base Sepolia.
 *
 * Simulates a real agent workflow:
 *  1. Create a free webhook inbox
 *  2. Receive an external webhook (Stripe/GitHub/human)
 *  3. Pay to drain_inbox and read events
 *  4. Pay to fetch_url for web research
 *
 * Usage: npm run paid-test  (server must be running with NETWORK=base-sepolia)
 */
import fs from "node:fs";

import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import { createPublicClient, erc20Abi, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { resolveCdpCredentials } from "../src/wallet.js";
import { createStreamableMcpTransport } from "./mcp-transport.js";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:4021/mcp";
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BUYER_KEY_PATH = new URL("../.buyer_key", import.meta.url).pathname;

function loadBuyerAccount() {
  let key: `0x${string}`;
  if (fs.existsSync(BUYER_KEY_PATH)) {
    key = fs.readFileSync(BUYER_KEY_PATH, "utf8").trim() as `0x${string}`;
  } else {
    key = generatePrivateKey();
    fs.writeFileSync(BUYER_KEY_PATH, key, { encoding: "utf8", mode: 0o600 });
  }
  return privateKeyToAccount(key);
}

async function requestUsdcFaucet(address: string): Promise<string> {
  const credentials = resolveCdpCredentials();
  const jwt = await generateJwt({
    apiKeyId: credentials.apiKeyId,
    apiKeySecret: credentials.apiKeySecret,
    requestMethod: "POST",
    requestHost: "api.cdp.coinbase.com",
    requestPath: "/platform/v2/evm/faucet",
  });

  const res = await fetch("https://api.cdp.coinbase.com/platform/v2/evm/faucet", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ address, network: "base-sepolia", token: "usdc" }),
  });
  if (!res.ok) {
    throw new Error(`CDP faucet failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { transactionHash: string };
  return body.transactionHash;
}

async function getFundedBuyer() {
  const buyer = loadBuyerAccount();
  console.log(`[buyer] Local wallet: ${buyer.address}`);

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
  let balance = await publicClient.readContract({
    address: USDC_BASE_SEPOLIA,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [buyer.address],
  });
  console.log(`[buyer] USDC balance: ${Number(balance) / 1e6}`);

  if (balance < 25_000n) {
    console.log("[buyer] Requesting USDC from CDP faucet...");
    const txHash = await requestUsdcFaucet(buyer.address);
    console.log(`[buyer] Faucet tx: ${txHash}`);
    await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
    for (let i = 0; i < 15; i++) {
      balance = await publicClient.readContract({
        address: USDC_BASE_SEPOLIA,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [buyer.address],
      });
      if (balance >= 25_000n) {
        console.log(`[buyer] USDC balance after faucet: ${Number(balance) / 1e6}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return buyer;
}

async function main(): Promise<void> {
  const buyer = await getFundedBuyer();

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

  const paymentClient = new x402Client().register("eip155:84532", new ExactEvmScheme(buyer));
  const mcpClient = new Client({ name: "agentwire-buyer-paid", version: "1.0.0" });
  const x402Mcp = wrapMCPClientWithPayment(mcpClient, paymentClient, {
    autoPayment: true,
    onPaymentRequested: ({ toolName, paymentRequired }) => {
      const accepts = paymentRequired.accepts[0];
      console.log(`[buyer] 402 for ${toolName}: paying ${accepts.amount} base units`);
      return true;
    },
  });
  await x402Mcp.connect(createStreamableMcpTransport(SERVER_URL));

  console.log("\n=== Step 3: drain_inbox (paid) ===");
  const drained = await x402Mcp.callTool(
    "drain_inbox",
    { inboxId: inbox.inboxId, secret: inbox.secret },
    { timeout: 180_000 },
  );
  console.log(`paymentMade=${drained.paymentMade} settlementTx=${drained.paymentResponse?.transaction}`);
  const drainBody = JSON.parse((drained.content[0] as { text: string }).text) as { drained: number };
  console.log((drained.content[0] as { text: string }).text);
  if (!drained.paymentMade || !drained.paymentResponse?.success) {
    throw new Error("Payment for drain_inbox did not settle");
  }
  if (drainBody.drained < 1) throw new Error("Expected at least one drained event");

  console.log("\n=== Step 4: fetch_url (paid) ===");
  const fetched = await x402Mcp.callTool(
    "fetch_url",
    { url: "https://example.com" },
    { timeout: 180_000 },
  );
  console.log(`paymentMade=${fetched.paymentMade} settlementTx=${fetched.paymentResponse?.transaction}`);
  const fetchBody = JSON.parse((fetched.content[0] as { text: string }).text) as {
    status: number;
    title: string | null;
  };
  console.log((fetched.content[0] as { text: string }).text);
  if (!fetched.paymentMade || !fetched.paymentResponse?.success) {
    throw new Error("Payment for fetch_url did not settle");
  }
  if (fetchBody.status !== 200) throw new Error(`fetch_url expected status 200, got ${fetchBody.status}`);

  await freeClient.close();
  await x402Mcp.close();

  console.log("\nPAID E2E TEST PASSED - two settled on-chain micro-payments:");
  console.log(`  1. https://sepolia.basescan.org/tx/${drained.paymentResponse.transaction}`);
  console.log(`  2. https://sepolia.basescan.org/tx/${fetched.paymentResponse.transaction}`);
}

main().catch((error) => {
  console.error("PAID E2E TEST FAILED:", error);
  process.exit(1);
});
