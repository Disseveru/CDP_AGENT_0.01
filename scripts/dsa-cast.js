#!/usr/bin/env node

const dotenv = require("dotenv");

dotenv.config();

const {
  buildDsaAccount,
  buildRecipe,
  castSpells,
  createDsaClient,
  ensureDsaInstance,
  formatChainLabel,
  listDsaAccounts,
  listRecipes,
  loadDsaState,
  parseSpellsInput,
  resolveDsaChainId,
  saveDsaState,
} = require("../lib/instadapp");

function printUsage() {
  console.log(`Instadapp DSA spell casting (dsa-connect)

Usage:
  node scripts/dsa-cast.js status
  node scripts/dsa-cast.js accounts
  node scripts/dsa-cast.js build
  node scripts/dsa-cast.js use <dsaId>
  node scripts/dsa-cast.js recipes
  node scripts/dsa-cast.js recipe <name> [--amountWei <wei>] [--to <address>]
  node scripts/dsa-cast.js encode '<json-spells>'
  node scripts/dsa-cast.js cast '<json-spells>' [--valueWei <wei>] [--build]
  node scripts/dsa-cast.js cast-file <path> [--valueWei <wei>] [--build]

Environment:
  DSA_PRIVATE_KEY / PRIVATE_KEY / MNEMONIC_PHRASE   Signer for spell authority
  DSA_CHAIN_ID                                      Default 8453 (Base mainnet)
  DSA_RPC_URL                                       Optional RPC override
  DSA_GAS_PRICE_GWEI                                Optional gas price override

Note: dsa-connect does not support Base Sepolia (84532). Use Base mainnet (8453).`);
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

async function main() {
  const [, , command, ...rest] = process.argv;
  const flags = parseFlags(rest);
  const positional = rest.filter((token) => !token.startsWith("--") && !Object.values(flags).includes(token));

  if (!command || command === "help" || command === "--help") {
    printUsage();
    return;
  }

  if (command === "recipes") {
    console.log(JSON.stringify(listRecipes(), null, 2));
    return;
  }

  if (command === "recipe") {
    const name = positional[0];
    if (!name) {
      throw new Error("Usage: node scripts/dsa-cast.js recipe <name> [--amountWei <wei>]");
    }

    const params = {
      amountWei: typeof flags.amountWei === "string" ? flags.amountWei : undefined,
      to: typeof flags.to === "string" ? flags.to : undefined,
    };

    console.log(JSON.stringify(buildRecipe(name, params), null, 2));
    return;
  }

  const { dsa, web3, chainId, signerAddress } = createDsaClient();
  const state = loadDsaState();

  if (command === "status") {
    console.log(
      JSON.stringify(
        {
          chainId,
          chain: formatChainLabel(chainId),
          signerAddress,
          persisted: state,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "accounts") {
    const accounts = await listDsaAccounts(dsa, signerAddress);
    console.log(JSON.stringify({ signerAddress, chainId, accounts }, null, 2));
    return;
  }

  if (command === "build") {
    const txHash = await buildDsaAccount(dsa, web3);
    const accounts = await listDsaAccounts(dsa, signerAddress);
    console.log(JSON.stringify({ txHash, accounts }, null, 2));
    return;
  }

  if (command === "use") {
    const dsaId = Number(positional[0]);
    if (!Number.isInteger(dsaId)) {
      throw new Error("Usage: node scripts/dsa-cast.js use <dsaId>");
    }

    const instance = await dsa.setInstance(dsaId);
    saveDsaState({
      ...state,
      chainId: resolveDsaChainId(),
      dsaId: instance.id,
      dsaAddress: instance.address,
      signerAddress,
    });

    console.log(JSON.stringify({ instance }, null, 2));
    return;
  }

  if (command === "encode") {
    const spellsInput = positional.join(" ");
    if (!spellsInput) {
      throw new Error("Usage: node scripts/dsa-cast.js encode '<json-spells>'");
    }

    await ensureDsaInstance(dsa, web3, signerAddress, {
      autoBuild: flags.build === true,
      chainId,
    });

    const result = await castSpells(dsa, web3, spellsInput, { dryRun: true });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "cast" || command === "cast-file") {
    let spellsInput = positional.join(" ");

    if (command === "cast-file") {
      const fs = require("fs");
      const filePath = positional[0];
      if (!filePath) {
        throw new Error("Usage: node scripts/dsa-cast.js cast-file <path>");
      }
      spellsInput = fs.readFileSync(filePath, "utf8");
    } else if (!spellsInput) {
      throw new Error("Usage: node scripts/dsa-cast.js cast '<json-spells>'");
    }

    parseSpellsInput(spellsInput);

    const ensured = await ensureDsaInstance(dsa, web3, signerAddress, {
      autoBuild: flags.build === true,
      chainId,
    });

    const result = await castSpells(dsa, web3, spellsInput, {
      valueWei: typeof flags.valueWei === "string" ? flags.valueWei : undefined,
    });

    console.log(
      JSON.stringify(
        {
          dsa: ensured.instance,
          createdDsa: ensured.created,
          ...result,
        },
        null,
        2,
      ),
    );
    return;
  }

  throw new Error(`Unknown command "${command}". Run with --help.`);
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
