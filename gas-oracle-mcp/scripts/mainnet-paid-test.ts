/**
 * Mainnet paid test using AgentKit CDP Smart Wallet + Base Paymaster.
 *
 * USDC is held on the smart wallet, then transferred to the owner EOA with
 * paymaster-sponsored gas. x402 EIP-3009 payments are signed by the owner EOA.
 *
 * Usage: npm run paid-test:mainnet  (server must be running with NETWORK=base)
 */
import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { base } from "viem/chains";

import { createMainnetPaymasterBuyer, toX402Signer } from "./buyer-wallet.js";
import { printSettlementSummary, runAllPaidEndpointTests } from "./paid-test-shared.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

async function main(): Promise<void> {
  const { smartWalletProvider, ownerProvider } = await createMainnetPaymasterBuyer();
  const signer = toX402Signer(ownerProvider);

  const publicClient = createPublicClient({ chain: base, transport: http() });
  const ownerBalance = await publicClient.readContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [ownerProvider.getAddress() as `0x${string}`],
  });
  console.log(`[buyer] Owner USDC balance for x402: ${formatUnits(ownerBalance, 6)}`);
  if (ownerBalance < 20_000n) {
    throw new Error(
      `Insufficient USDC on owner ${ownerProvider.getAddress()} after paymaster funding.`,
    );
  }

  console.log(`[buyer] Smart wallet (funding source): ${smartWalletProvider.getAddress()}`);

  const results = await runAllPaidEndpointTests(signer, {
    caip2Network: "eip155:8453",
    explorerBase: "https://basescan.org",
  });
  printSettlementSummary(results, "https://basescan.org");
}

main().catch((error) => {
  console.error("MAINNET PAID E2E TEST FAILED:", error);
  process.exit(1);
});
