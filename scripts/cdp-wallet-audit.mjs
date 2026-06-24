#!/usr/bin/env node
/**
 * Audit CDP EVM + smart accounts and highlight the canonical legacy wallet.
 *
 * Usage:
 *   node scripts/cdp-wallet-audit.mjs
 *   node scripts/cdp-wallet-audit.mjs --json
 */
import crypto from "node:crypto";
import { parseArgs } from "node:util";
import { createPublicClient, formatEther, formatUnits, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { CdpClient } from "@coinbase/cdp-sdk";

import { CANONICAL_LEGACY_ADDRESS } from "../lib/cdp/wallet-policy.js";

const USDC = {
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

const { values: args } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
  },
});

function resolveCredentials() {
  const apiKeyId = process.env.CDP_API_KEY || process.env.CDP_API_KEY_ID;
  const rawSecret = process.env.CDP_PRIVATE_KEY || process.env.CDP_API_KEY_SECRET;
  const walletSecret = process.env.CDP_WALLET_SECRET;
  if (!apiKeyId || !rawSecret || !walletSecret) {
    throw new Error("Missing CDP_API_KEY, CDP_PRIVATE_KEY, and CDP_WALLET_SECRET.");
  }

  let pem = rawSecret.replace(/\\n/g, "\n").trim();
  if (pem.includes("BEGIN EC PRIVATE KEY")) {
    pem = crypto
      .createPrivateKey({ key: pem, format: "pem", type: "sec1" })
      .export({ format: "pem", type: "pkcs8" })
      .toString();
  }

  return { apiKeyId, apiKeySecret: pem, walletSecret };
}

async function readBalances(chain, address) {
  const client = createPublicClient({ chain, transport: http() });
  const eth = await client.getBalance({ address });
  let usdc = 0n;
  try {
    usdc = await client.readContract({
      address: USDC[chain.id === 8453 ? "base" : "base-sepolia"],
      abi: [
        {
          name: "balanceOf",
          type: "function",
          stateMutability: "view",
          inputs: [{ type: "address" }],
          outputs: [{ type: "uint256" }],
        },
      ],
      functionName: "balanceOf",
      args: [address],
    });
  } catch {
    // ignore token read failures
  }

  return {
    eth: formatEther(eth),
    usdc: formatUnits(usdc, 6),
  };
}

async function listAll(listFn) {
  let page = await listFn();
  const all = [...page.accounts];
  while (page.nextPageToken) {
    page = await listFn({ pageToken: page.nextPageToken });
    all.push(...page.accounts);
  }
  return all;
}

async function main() {
  const cdp = new CdpClient(resolveCredentials());
  const evmAccounts = await listAll((options) => cdp.evm.listAccounts(options));
  const smartAccounts = await listAll((options) => cdp.evm.listSmartAccounts(options));

  const canonical = CANONICAL_LEGACY_ADDRESS.toLowerCase();
  const canonicalBalances = {
    sepolia: await readBalances(baseSepolia, CANONICAL_LEGACY_ADDRESS),
    base: await readBalances(base, CANONICAL_LEGACY_ADDRESS),
  };

  const funded = [];
  for (const account of evmAccounts) {
    const sepolia = await readBalances(baseSepolia, account.address);
    const mainnet = await readBalances(base, account.address);
    const hasFunds =
      Number(sepolia.eth) > 0 ||
      Number(sepolia.usdc) > 0 ||
      Number(mainnet.eth) > 0 ||
      Number(mainnet.usdc) > 0;
    if (hasFunds) {
      funded.push({
        type: "evm",
        address: account.address,
        name: account.name || "",
        sepolia,
        base: mainnet,
        canonical: account.address.toLowerCase() === canonical,
      });
    }
  }

  const report = {
    canonicalLegacyAddress: CANONICAL_LEGACY_ADDRESS,
    canonicalBalances,
    evmAccountCount: evmAccounts.length,
    smartAccountCount: smartAccounts.length,
    fundedEvmAccounts: funded,
    deleteNote:
      "CDP does not expose a public DELETE endpoint for EVM server wallets. Remove extras in the CDP Portal (Wallets / Server wallets) after sweeping funds to the canonical legacy address.",
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("CDP wallet audit");
  console.log(`Canonical legacy wallet: ${CANONICAL_LEGACY_ADDRESS}`);
  console.log(
    `  Base Sepolia: ${canonicalBalances.sepolia.eth} ETH, ${canonicalBalances.sepolia.usdc} USDC`,
  );
  console.log(`  Base mainnet: ${canonicalBalances.base.eth} ETH, ${canonicalBalances.base.usdc} USDC`);
  console.log("");
  console.log(`EVM server accounts: ${evmAccounts.length}`);
  console.log(`Smart accounts: ${smartAccounts.length}`);
  console.log(`Funded EVM accounts (excluding zero-balance): ${funded.length}`);
  for (const row of funded) {
    console.log(
      `  ${row.address}${row.name ? ` (${row.name})` : ""}${row.canonical ? " [canonical]" : ""}`,
    );
    console.log(`    sepolia ETH=${row.sepolia.eth} USDC=${row.sepolia.usdc}`);
    console.log(`    base    ETH=${row.base.eth} USDC=${row.base.usdc}`);
  }
  console.log("");
  console.log(report.deleteNote);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
