/**
 * Full end-to-end paid test on Base Sepolia.
 *
 * Pays for every paid endpoint:
 *  - peek_inbox
 *  - drain_inbox
 *  - fetch_url
 *  - GET / discovery
 *
 * Usage: npm run paid-test  (server must be running with NETWORK=base-sepolia)
 */
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { createPublicClient, erc20Abi, http } from "viem";
import { baseSepolia } from "viem/chains";

import { resolveCdpCredentials } from "../src/wallet.js";
import { loadTestnetEoaBuyer } from "./buyer-wallet.js";
import { printSettlementSummary, runAllPaidEndpointTests } from "./paid-test-shared.js";

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

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
  const buyer = loadTestnetEoaBuyer();
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
  const results = await runAllPaidEndpointTests(buyer, {
    caip2Network: "eip155:84532",
    explorerBase: "https://sepolia.basescan.org",
  });
  printSettlementSummary(results, "https://sepolia.basescan.org");
}

main().catch((error) => {
  console.error("PAID E2E TEST FAILED:", error);
  process.exit(1);
});
