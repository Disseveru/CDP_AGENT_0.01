#!/usr/bin/env node

const dotenv = require("dotenv");

dotenv.config();

const {
  buildOpportunitySpells,
  enrichArbitrageUnits,
  castSpells,
  createDsaClient,
  ensureDsaInstance,
  formatChainLabel,
  getDsaGasStatus,
  loadSearcherConfig,
  resolveDsaChainId,
  resolveSigningKey,
  scanOpportunities,
} = require("../lib/instadapp");

function printUsage() {
  console.log(`Instadapp DSA searcher (flash loans, arbitrage, liquidations)

Uses DSA_PRIVATE_KEY (EOA owner) with the Avocado SDK USDC gas tank for L2 execution.

Usage:
  node scripts/dsa-searcher.js config
  node scripts/dsa-searcher.js gas [--chainId <id>]
  node scripts/dsa-searcher.js scan [--chainId <id>]
  node scripts/dsa-searcher.js encode-opportunity '<json>'
  node scripts/dsa-searcher.js cast-opportunity '<json>' [--build] [--dry-run]

Environment:
  DSA_PRIVATE_KEY              EOA private key (Avocado owner + DSA signer)
  DSA_CHAIN_ID                 Default chain (8453 Base)
  DSA_USE_AVOCADO              Default 1 — broadcast via Avocado USDC gas tank
  DSA_USE_PAYMASTER            Set 0 to disable legacy CDP paymaster fallback`);
}

/**
 * @param {string[]} argv
 */
function parseFlags(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    i += 1;
  }

  return flags;
}

/**
 * @param {Record<string, string | boolean>} flags
 */
function resolveScanChains(flags) {
  if (typeof flags.chainId === "string") {
    return [Number(flags.chainId)];
  }

  return loadSearcherConfig().chains;
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const flags = parseFlags(rest);
  const positional = rest.filter((token) => !token.startsWith("--") && !Object.values(flags).includes(token));

  if (!command || command === "help" || command === "--help") {
    printUsage();
    return;
  }

  if (command === "config") {
    console.log(JSON.stringify(loadSearcherConfig(), null, 2));
    return;
  }

  const chainId =
    typeof flags.chainId === "string" ? Number(flags.chainId) : resolveDsaChainId();
  const privateKey = resolveSigningKey();
  const Web3 = require("web3");
  const signerAddress = new Web3().eth.accounts.privateKeyToAccount(privateKey).address;

  if (command === "gas") {
    const gasStatus = await getDsaGasStatus(signerAddress, chainId);
    console.log(
      JSON.stringify(
        {
          ownerAddress: signerAddress,
          chainId,
          chain: formatChainLabel(chainId),
          ...gasStatus,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "scan") {
    const opportunities = await scanOpportunities({ chains: resolveScanChains(flags) });
    console.log(JSON.stringify({ opportunities, count: opportunities.length }, null, 2));
    return;
  }

  if (command === "encode-opportunity" || command === "cast-opportunity") {
    const jsonText = positional.join(" ").trim();
    if (!jsonText) {
      throw new Error(`Usage: node scripts/dsa-searcher.js ${command} '<json>'`);
    }

    const opportunity = JSON.parse(jsonText);
    const targetChainId = Number(opportunity.chainId || chainId);
    const { dsa, web3 } = createDsaClient({ chainId: targetChainId, privateKey });

    await ensureDsaInstance(dsa, web3, signerAddress, {
      autoBuild: flags.build === true,
      chainId: targetChainId,
    });

    const enriched =
      opportunity.type === "arbitrage" && !opportunity.unitAmtForward
        ? enrichArbitrageUnits(opportunity, web3)
        : opportunity;

    const spells = buildOpportunitySpells(dsa, enriched);

    if (command === "encode-opportunity" || flags["dry-run"] === true) {
      const result = await castSpells(dsa, web3, spells, {
        dryRun: true,
        chainId: targetChainId,
        signerAddress,
        flashLoan: true,
      });
      console.log(JSON.stringify({ opportunity: enriched, spells, ...result }, null, 2));
      return;
    }

    const result = await castSpells(dsa, web3, spells, {
      chainId: targetChainId,
      signerAddress,
      flashLoan: true,
    });
    console.log(JSON.stringify({ opportunity: enriched, spells, ...result }, null, 2));
    return;
  }

  throw new Error(`Unknown command "${command}". Run with --help.`);
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
