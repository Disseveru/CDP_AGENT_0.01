/**
 * Full end-to-end paid test on Base Sepolia.
 *
 * Plays the role of an autonomous buyer agent:
 *  1. Generates (or reuses) a local buyer wallet (.buyer_key, gitignored)
 *  2. Tops it up with testnet USDC from the CDP faucet when empty
 *  3. Calls the paid tools - the x402 client auto-signs the EIP-3009 payment,
 *     the server verifies + settles it on-chain, then releases the payload
 *
 * Usage: npm run paid-test  (server must be running with NETWORK=base-sepolia)
 */
import fs from "node:fs";

import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import { createPublicClient, erc20Abi, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { resolveCdpCredentials } from "../src/wallet.js";

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
  const balance = await publicClient.readContract({
    address: USDC_BASE_SEPOLIA,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [buyer.address],
  });
  console.log(`[buyer] USDC balance: ${Number(balance) / 1e6}`);

  if (balance < 10_000n) {
    console.log("[buyer] Requesting USDC from CDP faucet...");
    const txHash = await requestUsdcFaucet(buyer.address);
    console.log(`[buyer] Faucet tx: ${txHash}`);
    await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
    console.log("[buyer] Faucet confirmed");
  }

  return buyer;
}

async function main(): Promise<void> {
  const buyer = await getFundedBuyer();

  const paymentClient = new x402Client().register("eip155:84532", new ExactEvmScheme(buyer));

  const mcpClient = new Client({ name: "chainpulse-buyer", version: "1.0.0" });
  const x402Mcp = wrapMCPClientWithPayment(mcpClient, paymentClient, {
    autoPayment: true,
    onPaymentRequested: ({ toolName, paymentRequired }) => {
      const accepts = paymentRequired.accepts[0];
      console.log(
        `[buyer] 402 for ${toolName}: paying ${accepts.amount} (base units) on ${accepts.network}`,
      );
      return true;
    },
  });

  await x402Mcp.connect(new StreamableHTTPClientTransport(new URL(SERVER_URL)));

  console.log("\n=== Paid call 1: get_gas_snapshot ===");
  const snapshot = await x402Mcp.callTool("get_gas_snapshot", {}, { timeout: 180_000 });
  console.log(`paymentMade=${snapshot.paymentMade} settlementTx=${snapshot.paymentResponse?.transaction}`);
  console.log((snapshot.content[0] as { text: string }).text);
  if (!snapshot.paymentMade || !snapshot.paymentResponse?.success) {
    throw new Error("Payment for get_gas_snapshot did not settle");
  }

  console.log("\n=== Paid call 2: recommend_cheapest_chain (swap) ===");
  const recommendation = await x402Mcp.callTool(
    "recommend_cheapest_chain",
    { txType: "swap" },
    { timeout: 180_000 },
  );
  console.log(
    `paymentMade=${recommendation.paymentMade} settlementTx=${recommendation.paymentResponse?.transaction}`,
  );
  console.log((recommendation.content[0] as { text: string }).text);
  if (!recommendation.paymentMade || !recommendation.paymentResponse?.success) {
    throw new Error("Payment for recommend_cheapest_chain did not settle");
  }

  await x402Mcp.close();
  console.log("\nPAID E2E TEST PASSED - two settled on-chain micro-payments:");
  console.log(`  1. https://sepolia.basescan.org/tx/${snapshot.paymentResponse.transaction}`);
  console.log(`  2. https://sepolia.basescan.org/tx/${recommendation.paymentResponse.transaction}`);
}

main().catch((error) => {
  console.error("PAID E2E TEST FAILED:", error);
  process.exit(1);
});
