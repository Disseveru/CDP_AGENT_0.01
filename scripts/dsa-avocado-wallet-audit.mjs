#!/usr/bin/env node
/**
 * Audit DSA + Avocado safes and cross-check CDP wallets before deletion.
 *
 * Usage:
 *   node scripts/dsa-avocado-wallet-audit.mjs
 *   node scripts/dsa-avocado-wallet-audit.mjs --json
 */
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { createPublicClient, formatEther, formatUnits, http, isAddress } from "viem";
import { arbitrum, base, baseSepolia, optimism, polygon } from "viem/chains";
import { CdpClient } from "@coinbase/cdp-sdk";

const require = createRequire(import.meta.url);
const instadapp = require("../lib/instadapp");
const { CANONICAL_LEGACY_ADDRESS } = require("../lib/cdp/wallet-policy.js");
const { SUPPORTED_DSA_CHAIN_IDS, CHAIN_LABELS } = require("../lib/instadapp/constants");

const { values: args } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
  },
});

const VIEM_CHAINS = {
  8453: base,
  84532: baseSepolia,
  42161: arbitrum,
  137: polygon,
  10: optimism,
};

const USDC = {
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  137: "0x3c499c542cEF5E3811e19d4d638b92d7C6f7C8C2",
  10: "0x0b2C639c533813c4Aa9D7837CAf62653d097Ff85",
};

const BALANCE_CHAINS = [8453, 84532, 42161, 137, 10];

function resolveCdpCredentials() {
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

async function listAll(listFn) {
  let page = await listFn();
  const all = [...page.accounts];
  while (page.nextPageToken) {
    page = await listFn({ pageToken: page.nextPageToken });
    all.push(...page.accounts);
  }
  return all;
}

async function readOnchainBalances(chainId, address) {
  const viemChain = VIEM_CHAINS[chainId];
  if (!viemChain || !isAddress(address)) {
    return null;
  }

  const client = createPublicClient({ chain: viemChain, transport: http() });
  const eth = await client.getBalance({ address });
  let usdc = 0n;
  const token = USDC[chainId];
  if (token) {
    try {
      usdc = await client.readContract({
        address: token,
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
  }

  return {
    eth: formatEther(eth),
    usdc: formatUnits(usdc, 6),
  };
}

function hasOnchainFunds(balances) {
  if (!balances) {
    return false;
  }
  return Number(balances.eth) > 0 || Number(balances.usdc) > 0;
}

function hasAvocadoGasFunds(balanceHuman) {
  return Number(balanceHuman) > 0;
}

async function scanAddressBalances(address, chains = BALANCE_CHAINS) {
  const perChain = {};
  let anyFunds = false;

  for (const chainId of chains) {
    const balances = await readOnchainBalances(chainId, address);
    perChain[CHAIN_LABELS[chainId] || String(chainId)] = balances;
    if (hasOnchainFunds(balances)) {
      anyFunds = true;
    }
  }

  return { perChain, anyFunds };
}

async function main() {
  const protectedAddresses = new Map();
  const fundedRows = [];
  const dsaRows = [];
  const avocadoRows = [];

  function protect(address, reason, extra = {}) {
    protectedAddresses.set(address.toLowerCase(), { address, reason, ...extra });
  }

  const { signerAddress: ownerEoa } = instadapp.createDsaClient();
  protect(ownerEoa, "DSA owner EOA (MNEMONIC signer)");
  protect(CANONICAL_LEGACY_ADDRESS, "Canonical CDP legacy wallet (PAY_TO)");

  const ownerScan = await scanAddressBalances(ownerEoa);
  if (ownerScan.anyFunds) {
    fundedRows.push({
      role: "DSA owner EOA",
      address: ownerEoa,
      ...ownerScan.perChain,
    });
  }

  const legacyScan = await scanAddressBalances(CANONICAL_LEGACY_ADDRESS);
  if (legacyScan.anyFunds) {
    fundedRows.push({
      role: "Canonical CDP legacy wallet",
      address: CANONICAL_LEGACY_ADDRESS,
      ...legacyScan.perChain,
    });
  }

  const avocadoOverview = await instadapp.getAvocadoGasOverview(ownerEoa);
  for (const safe of avocadoOverview.safes) {
    const gasUsdc = safe.balanceHuman;
    const onchain = await scanAddressBalances(safe.safeAddress);

    avocadoRows.push({
      safeAddress: safe.safeAddress,
      gasUsdc,
      selected: Boolean(safe.selected),
      onchain: onchain.perChain,
    });

    protect(safe.safeAddress, "Avocado safe", {
      gasUsdc,
      selected: Boolean(safe.selected),
    });

    if (hasAvocadoGasFunds(gasUsdc) || onchain.anyFunds) {
      fundedRows.push({
        role: "Avocado safe",
        address: safe.safeAddress,
        gasUsdc,
        selected: Boolean(safe.selected),
        ...onchain.perChain,
      });
    }

    for (const chainId of SUPPORTED_DSA_CHAIN_IDS) {
      if (!VIEM_CHAINS[chainId]) {
        continue;
      }

      try {
        const { dsa } = instadapp.createDsaClient({ chainId });
        const accounts = await instadapp.listDsaAccounts(dsa, safe.safeAddress);
        for (const account of accounts) {
          const chainLabel = CHAIN_LABELS[chainId] || String(chainId);
          const balances = await readOnchainBalances(chainId, account.address);
          const row = {
            dsaId: account.id,
            address: account.address,
            authority: safe.safeAddress,
            chain: chainLabel,
            eth: balances?.eth ?? "0",
            usdc: balances?.usdc ?? "0",
          };
          dsaRows.push(row);
          protect(account.address, "DSA account", {
            dsaId: account.id,
            authority: safe.safeAddress,
            chain: chainLabel,
          });

          if (hasOnchainFunds(balances)) {
            fundedRows.push({ role: "DSA account", ...row });
          }
        }
      } catch (error) {
        dsaRows.push({
          authority: safe.safeAddress,
          chain: CHAIN_LABELS[chainId] || String(chainId),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // DSA accounts controlled directly by the EOA (non-Avocado authority).
  for (const chainId of SUPPORTED_DSA_CHAIN_IDS) {
    if (!VIEM_CHAINS[chainId]) {
      continue;
    }

    try {
      const { dsa } = instadapp.createDsaClient({ chainId });
      const accounts = await instadapp.listDsaAccounts(dsa, ownerEoa);
      for (const account of accounts) {
        if (protectedAddresses.has(account.address.toLowerCase())) {
          continue;
        }

        const chainLabel = CHAIN_LABELS[chainId] || String(chainId);
        const balances = await readOnchainBalances(chainId, account.address);
        const row = {
          dsaId: account.id,
          address: account.address,
          authority: ownerEoa,
          chain: chainLabel,
          eth: balances?.eth ?? "0",
          usdc: balances?.usdc ?? "0",
        };
        dsaRows.push(row);
        protect(account.address, "DSA account (EOA authority)", row);

        if (hasOnchainFunds(balances)) {
          fundedRows.push({ role: "DSA account (EOA authority)", ...row });
        }
      }
    } catch {
      // ignore unsupported chain errors
    }
  }

  const cdp = new CdpClient(resolveCdpCredentials());
  const evmAccounts = await listAll((options) => cdp.evm.listAccounts(options));
  const smartAccounts = await listAll((options) => cdp.evm.listSmartAccounts(options));

  const cdpFunded = [];
  const cdpEmptyAndUnlinked = [];

  for (const account of evmAccounts) {
    const scan = await scanAddressBalances(account.address);
    const linked = protectedAddresses.has(account.address.toLowerCase());
    const isCanonical =
      account.address.toLowerCase() === CANONICAL_LEGACY_ADDRESS.toLowerCase();

    const row = {
      address: account.address,
      name: account.name || "",
      linkedToDsaOrAvocado: linked,
      isCanonicalLegacy: isCanonical,
      balances: scan.perChain,
    };

    if (scan.anyFunds) {
      cdpFunded.push(row);
      fundedRows.push({
        role: "CDP EVM server wallet",
        address: account.address,
        name: account.name || "",
        linkedToDsaOrAvocado: linked,
        ...scan.perChain,
      });
    } else if (!linked && !isCanonical) {
      cdpEmptyAndUnlinked.push(row);
    }
  }

  const report = {
    ownerEoa,
    selectedAvocadoSafe: avocadoOverview.selectedSafeAddress,
    canonicalLegacyAddress: CANONICAL_LEGACY_ADDRESS,
    protectedAddressCount: protectedAddresses.size,
    avocadoSafeCount: avocadoRows.length,
    dsaAccountCount: dsaRows.filter((row) => row.address).length,
    cdpEvmCount: evmAccounts.length,
    cdpSmartCount: smartAccounts.length,
    fundedRows,
    protectedAddresses: [...protectedAddresses.values()],
    avocadoSafes: avocadoRows,
    dsaAccounts: dsaRows,
    cdpFundedWallets: cdpFunded,
    cdpEmptyUnlinkedCount: cdpEmptyAndUnlinked.length,
    deletionGuidance: {
      neverDelete: [...protectedAddresses.values()].map((row) => row.address),
      cdpEmptyUnlinkedSafeToReview: cdpEmptyAndUnlinked.length,
      note:
        "Sweep any CDP wallet with funds to the canonical legacy wallet before portal deletion. Avocado gas tanks are off-chain USDC balances, not on-chain ERC-20.",
    },
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("DSA + Avocado + CDP wallet audit");
  console.log(`Owner EOA: ${ownerEoa}`);
  console.log(`Selected Avocado safe: ${avocadoOverview.selectedSafeAddress}`);
  console.log(`Canonical legacy CDP wallet: ${CANONICAL_LEGACY_ADDRESS}`);
  console.log("");

  console.log(`Protected addresses (DSA/Avocado/legacy): ${protectedAddresses.size}`);
  for (const row of report.protectedAddresses) {
    const extra = row.gasUsdc ? ` gas=${row.gasUsdc} USDC` : "";
    const dsa = row.dsaId ? ` dsaId=${row.dsaId}` : "";
    console.log(`  ${row.address} — ${row.reason}${extra}${dsa}`);
  }
  console.log("");

  console.log("Avocado safes:");
  for (const safe of avocadoRows) {
    console.log(
      `  ${safe.safeAddress}${safe.selected ? " [selected]" : ""} — gas ${safe.gasUsdc} USDC`,
    );
  }
  console.log("");

  if (dsaRows.length) {
    console.log("DSA accounts:");
    for (const row of dsaRows) {
      if (row.error) {
        console.log(`  authority ${row.authority} @ ${row.chain}: ${row.error}`);
        continue;
      }
      console.log(
        `  dsaId=${row.dsaId} ${row.address} authority=${row.authority} @ ${row.chain} ETH=${row.eth} USDC=${row.usdc}`,
      );
    }
    console.log("");
  }

  console.log(`Addresses with any balance (on-chain or Avocado gas): ${fundedRows.length}`);
  for (const row of fundedRows) {
    const parts = [];
    for (const [chain, balances] of Object.entries(row)) {
      if (!balances || typeof balances !== "object" || !("eth" in balances)) {
        continue;
      }
      if (hasOnchainFunds(balances)) {
        parts.push(`${chain}: ${balances.eth} ETH, ${balances.usdc} USDC`);
      }
    }
    if (row.gasUsdc && hasAvocadoGasFunds(row.gasUsdc)) {
      parts.push(`avocado-gas: ${row.gasUsdc} USDC`);
    }
    console.log(`  [${row.role}] ${row.address}${row.name ? ` (${row.name})` : ""}`);
    for (const part of parts) {
      console.log(`    ${part}`);
    }
  }
  console.log("");

  console.log(`CDP EVM wallets with funds: ${cdpFunded.length}`);
  for (const row of cdpFunded) {
    console.log(
      `  ${row.address}${row.name ? ` (${row.name})` : ""} linked=${row.linkedToDsaOrAvocado}`,
    );
  }
  console.log("");

  console.log(`CDP EVM wallets empty and not linked to DSA/Avocado: ${cdpEmptyAndUnlinked.length}`);
  console.log(report.deletionGuidance.note);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
