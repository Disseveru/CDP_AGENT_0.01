const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const dotenv = require("dotenv");
const {
  AgentKit,
  CdpEvmWalletProvider,
  CdpSmartWalletProvider,
  walletActionProvider,
  cdpApiActionProvider,
  cdpSmartWalletActionProvider,
  legacyCdpWalletActionProvider,
  erc721ActionProvider,
  LegacyCdpWalletProvider,
} = require("@coinbase/agentkit");
const { CdpClient } = require("@coinbase/cdp-sdk");
const { generateJwt } = require("@coinbase/cdp-sdk/auth");
const { getLangChainTools } = require("@coinbase/agentkit-langchain");
const instadapp = require("./lib/instadapp");

dotenv.config();

const WALLET_DATA_PATH = path.join(__dirname, "wallet_data.txt");
const NETWORK_ID = process.env.NETWORK_ID || "base-sepolia";

const DEFAULT_RPC_URLS = {
  "base-sepolia": "https://sepolia.base.org",
  "base-mainnet": "https://mainnet.base.org",
};

/**
 * Resolves CDP credentials from the supported environment variables only.
 *
 * @returns {{ apiKeyId: string, apiKeySecretLegacy: string, apiKeySecretV2: string, walletSecret: string }}
 */
function resolveEnvAlias(primaryName, fallbackName) {
  return process.env[primaryName] || process.env[fallbackName];
}

function resolveCdpCredentials() {
  const apiKeyId = resolveEnvAlias("CDP_API_KEY", "CDP_API_KEY_ID");
  const apiKeySecretRaw = resolveEnvAlias("CDP_PRIVATE_KEY", "CDP_API_KEY_SECRET");
  const walletSecret = process.env.CDP_WALLET_SECRET;

  if (!apiKeyId || !apiKeySecretRaw || !walletSecret) {
    throw new Error(
      "Missing CDP credentials. Set CDP_API_KEY (or CDP_API_KEY_ID), CDP_PRIVATE_KEY (or CDP_API_KEY_SECRET), and CDP_WALLET_SECRET.",
    );
  }

  let pem = apiKeySecretRaw.replace(/\\n/g, "\n").trim();

  if (!pem.includes("\n")) {
    const match = pem.match(/-----BEGIN ([^-]+)-----(.*?)-----END \1-----/);
    if (match) {
      const [, type, body] = match;
      const cleanBody = body.replace(/\s+/g, "");
      const lines = cleanBody.match(/.{1,64}/g) || [];
      pem = `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----`;
    }
  }

  const apiKeySecretLegacy = pem;
  const apiKeySecretV2 = pem.includes("BEGIN EC PRIVATE KEY")
    ? crypto.createPrivateKey({ key: pem, format: "pem", type: "sec1" }).export({
        format: "pem",
        type: "pkcs8",
      })
    : pem;

  return { apiKeyId, apiKeySecretLegacy, apiKeySecretV2, walletSecret };
}

/**
 * Returns true when the agent should use a CDP Smart Wallet with Base Paymaster.
 *
 * @param {object|undefined} existingWalletData
 */
function isBasePaymasterEnabled() {
  if (isLegacyWalletEnabled()) {
    return false;
  }

  if (process.env.USE_EOA_WALLET === "1" || process.env.USE_EOA_WALLET === "true") {
    return false;
  }

  if (process.env.BASE_PAYMASTER === "0" || process.env.BASE_PAYMASTER === "false") {
    return false;
  }

  return true;
}

function isLegacyWalletEnabled() {
  return process.env.USE_LEGACY_WALLET === "1" || process.env.USE_LEGACY_WALLET === "true";
}

function isLegacyWalletData(walletData) {
  return Boolean(walletData && (walletData.walletId || walletData.seed));
}

/**
 * Resolves the CDP Base Paymaster & Bundler endpoint for gas sponsorship.
 *
 * @param {ReturnType<typeof resolveCdpCredentials>} credentials
 * @param {string} networkId
 */
async function resolveBasePaymasterUrl(credentials, networkId) {
  const explicitUrl =
    process.env.PAYMASTER_URL ||
    process.env.BASE_PAYMASTER_URL ||
    process.env.CDP_PAYMASTER_URL;

  if (explicitUrl) {
    return explicitUrl;
  }

  const paymasterNetwork = networkId === "base-mainnet" ? "base" : "base-sepolia";
  const basePath = "https://api.cdp.coinbase.com";
  const jwt = await generateJwt({
    apiKeyId: credentials.apiKeyId,
    apiKeySecret: credentials.apiKeySecretV2,
    requestMethod: "GET",
    requestHost: "api.cdp.coinbase.com",
    requestPath: "/apikeys/v1/tokens/active",
  });

  const response = await fetch(`${basePath}/apikeys/v1/tokens/active`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to resolve Base Paymaster URL (${response.status}).`);
  }

  const { id } = await response.json();
  return `${basePath}/rpc/v1/${paymasterNetwork}/${id}`;
}

/**
 * @param {string} networkId
 */
function resolveRpcUrl(networkId) {
  return process.env.RPC_URL || DEFAULT_RPC_URLS[networkId];
}

/**
 * Validates required environment variables.
 */
function validateEnvironment() {
  const missing = [];
  const apiKeyId = resolveEnvAlias("CDP_API_KEY", "CDP_API_KEY_ID");
  const apiKeySecret = resolveEnvAlias("CDP_PRIVATE_KEY", "CDP_API_KEY_SECRET");

  if (!apiKeyId) {
    missing.push("CDP_API_KEY or CDP_API_KEY_ID");
  }
  if (!apiKeySecret) {
    missing.push("CDP_PRIVATE_KEY or CDP_API_KEY_SECRET");
  }
  if (!process.env.CDP_WALLET_SECRET) {
    missing.push("CDP_WALLET_SECRET");
  }

  if (missing.length > 0) {
    console.error("Error: missing required environment variables:");
    missing.forEach((name) => console.error(`  ${name}`));
    process.exit(1);
  }
}

/**
 * Loads persisted wallet data from disk when available.
 *
 * @returns {object|undefined}
 */
function loadWalletData() {
  if (!fs.existsSync(WALLET_DATA_PATH)) {
    return undefined;
  }

  const raw = fs.readFileSync(WALLET_DATA_PATH, "utf8");
  if (!raw.trim()) {
    return undefined;
  }

  return JSON.parse(raw);
}

/**
 * Persists wallet export data for local reuse across sessions.
 *
 * @param {import("@coinbase/agentkit").CdpEvmWalletProvider | import("@coinbase/agentkit").LegacyCdpWalletProvider} walletProvider
 */
async function persistWallet(walletProvider) {
  const walletData = await walletProvider.exportWallet();
  fs.writeFileSync(WALLET_DATA_PATH, JSON.stringify(walletData, null, 2), { encoding: "utf8", mode: 0o600 });
  console.log(`Wallet state saved to ${WALLET_DATA_PATH}`);
}

/**
 * Finds an existing smart wallet owned by the given server wallet.
 *
 * @param {ReturnType<typeof resolveCdpCredentials>} credentials
 * @param {string} ownerAddress
 */
async function findSmartWalletAddress(credentials, ownerAddress) {
  const cdpClient = new CdpClient({
    apiKeyId: credentials.apiKeyId,
    apiKeySecret: credentials.apiKeySecretV2,
    walletSecret: credentials.walletSecret,
  });

  const page = await cdpClient.evm.listSmartAccounts();
  const match = page.accounts.find((account) =>
    account.owners?.some((owner) => owner.toLowerCase() === ownerAddress.toLowerCase()),
  );

  return match?.address;
}

/**
 * Creates a CDP Smart Wallet with Base Paymaster gas sponsorship.
 *
 * @param {ReturnType<typeof resolveCdpCredentials>} credentials
 * @param {object|undefined} existingWalletData
 */
async function createSmartWalletProvider(credentials, existingWalletData) {
  const { apiKeyId, apiKeySecretV2, walletSecret } = credentials;
  const paymasterUrl = await resolveBasePaymasterUrl(credentials, NETWORK_ID);
  const ownerAddress = existingWalletData?.ownerAddress || existingWalletData?.address;
  let smartWalletAddress = existingWalletData?.ownerAddress
    ? existingWalletData.address
    : undefined;

  if (!smartWalletAddress && ownerAddress) {
    smartWalletAddress = await findSmartWalletAddress(credentials, ownerAddress);
  }

  const walletProvider = await CdpSmartWalletProvider.configureWithWallet({
    apiKeyId,
    apiKeySecret: apiKeySecretV2,
    walletSecret,
    networkId: NETWORK_ID,
    rpcUrl: resolveRpcUrl(NETWORK_ID),
    paymasterUrl,
    owner: ownerAddress,
    address: smartWalletAddress,
    smartAccountName: existingWalletData?.ownerAddress ? existingWalletData.name : undefined,
  });

  return { walletProvider, walletMode: "smart", paymasterUrl };
}

/**
 * Creates the wallet provider, preferring CDP Smart Wallet + Paymaster when enabled,
 * then CDP v2, with legacy fallback for deploy_token support.
 *
 * @param {ReturnType<typeof resolveCdpCredentials>} credentials
 * @param {object|undefined} existingWalletData
 */
async function createWalletProvider(credentials, existingWalletData) {
  const { apiKeyId, apiKeySecretLegacy, apiKeySecretV2, walletSecret } = credentials;

  if (isLegacyWalletEnabled()) {
    const walletProvider = await LegacyCdpWalletProvider.configureWithWallet({
      apiKeyId,
      apiKeySecret: apiKeySecretLegacy,
      networkId: NETWORK_ID,
      ...(isLegacyWalletData(existingWalletData)
        ? { cdpWalletData: JSON.stringify(existingWalletData) }
        : {}),
    });

    return { walletProvider, walletMode: "legacy" };
  }

  if (isBasePaymasterEnabled()) {
    return createSmartWalletProvider(credentials, existingWalletData);
  }

  if (existingWalletData?.address && !existingWalletData?.walletId && !existingWalletData?.ownerAddress) {
    const walletProvider = await CdpEvmWalletProvider.configureWithWallet({
      apiKeyId,
      apiKeySecret: apiKeySecretV2,
      walletSecret,
      networkId: NETWORK_ID,
      address: existingWalletData.address,
    });

    return { walletProvider, walletMode: "v2" };
  }

  if (existingWalletData && (existingWalletData.walletId || existingWalletData.seed)) {
    const walletProvider = await LegacyCdpWalletProvider.configureWithWallet({
      apiKeyId,
      apiKeySecret: apiKeySecretLegacy,
      networkId: NETWORK_ID,
      cdpWalletData: JSON.stringify(existingWalletData),
    });

    return { walletProvider, walletMode: "legacy" };
  }

  try {
    const walletProvider = await CdpEvmWalletProvider.configureWithWallet({
      apiKeyId,
      apiKeySecret: apiKeySecretV2,
      walletSecret,
      networkId: NETWORK_ID,
    });

    return { walletProvider, walletMode: "v2" };
  } catch (error) {
    console.warn(
      `CDP v2 wallet initialization failed (${error instanceof Error ? error.message : error}). Trying legacy wallet...`,
    );
  }

  const walletProvider = await LegacyCdpWalletProvider.configureWithWallet({
    apiKeyId,
    apiKeySecret: apiKeySecretLegacy,
    networkId: NETWORK_ID,
  });

  return { walletProvider, walletMode: "legacy" };
}

/**
 * @param {import("@langchain/core/tools").StructuredTool[]} tools
 */
function indexTools(tools) {
  /** @type {Map<string, import("@langchain/core/tools").StructuredTool>} */
  const byName = new Map();

  for (const tool of tools) {
    byName.set(tool.name, tool);

    const providerMatch = tool.name.match(/Provider_(.+)$/);
    const shortName = providerMatch?.[1] || tool.name;
    if (!byName.has(shortName)) {
      byName.set(shortName, tool);
    }
  }

  return byName;
}

/**
 * @param {string} name
 * @param {import("@langchain/core/tools").StructuredTool[]} tools
 */
function findTool(name, tools) {
  const exact = tools.find((tool) => tool.name === name);
  if (exact) {
    return exact;
  }

  return tools.find((tool) => tool.name.endsWith(`_${name}`));
}

/**
 * @param {import("@langchain/core/tools").StructuredTool[]} tools
 */
function printHelp(tools) {
  console.log("Commands:");
  console.log("  help                         Show this help");
  console.log("  wallet                       Show wallet address, network, and balances");
  console.log("  deploy-token <name> <symbol> <supply>");
  console.log("                               Deploy an ERC-20 token (requires USE_LEGACY_WALLET=1)");
  console.log("  mint <contract> <destination> Mint an ERC-721 NFT");
  console.log("  send <to> <amount>           Send native ETH (smart wallet mode)");
  console.log("  faucet                       Request Base Sepolia test funds (EOA mode)");
  console.log("  dsa accounts|build|recipes   Instadapp DSA account management");
  console.log("  dsa scan|gas                 Flash-loan searcher scan / paymaster gas");
  console.log("  dsa encode <json>            Encode spells without broadcasting");
  console.log("  dsa cast <json> [--build]    Cast Instadapp spells on Base mainnet (8453)");
  console.log("  run <tool> [json]            Invoke any registered tool with JSON args");
  console.log("  exit                         Quit");
  console.log("\nRegistered tools:");

  for (const tool of tools) {
    console.log(`  ${tool.name}`);
    if (tool.description) {
      console.log(`    ${tool.description.split("\n")[0]}`);
    }
  }
}

/**
 * @param {string} input
 * @param {import("@langchain/core/tools").StructuredTool[]} tools
 * @param {Map<string, import("@langchain/core/tools").StructuredTool>} toolsByName
 */
function parseCommandInput(input, tools, toolsByName) {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (lower === "help" || lower === "?") {
    return { type: "help" };
  }

  if (trimmed.startsWith("{")) {
    throw new Error("Pass JSON args after a tool name, e.g. run mint {\"contractAddress\":\"0x...\"}.");
  }

  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const [command, ...rest] = tokens;
  const normalized = command.toLowerCase();

  if (normalized === "dsa") {
    return { type: "dsa", subcommand: rest[0]?.toLowerCase(), args: rest.slice(1) };
  }

  const aliases = {
    wallet: "get_wallet_details",
    "deploy-token": "deploy_token",
    deploy_token: "deploy_token",
    send: "native_transfer",
    faucet: "request_faucet_funds",
  };

  const toolName = aliases[normalized] || command;
  const tool = toolsByName.get(toolName) || findTool(toolName, tools);

  if (!tool) {
    throw new Error(`Unknown command "${command}". Type help to list available commands.`);
  }

  if (normalized === "mint" && rest.length >= 2) {
    return {
      type: "invoke",
      tool,
      args: {
        contractAddress: rest[0].replace(/^['"]|['"]$/g, ""),
        destination: rest[1].replace(/^['"]|['"]$/g, ""),
      },
    };
  }

  if ((normalized === "deploy-token" || normalized === "deploy_token") && rest.length >= 3) {
    return {
      type: "invoke",
      tool,
      args: {
        name: rest[0].replace(/^['"]|['"]$/g, ""),
        symbol: rest[1].replace(/^['"]|['"]$/g, ""),
        totalSupply: BigInt(rest[2].replace(/^['"]|['"]$/g, "")),
      },
    };
  }

  if ((normalized === "send" || toolName === "native_transfer") && rest.length >= 2) {
    return {
      type: "invoke",
      tool,
      args: {
        to: rest[0].replace(/^['"]|['"]$/g, ""),
        value: rest[1].replace(/^['"]|['"]$/g, ""),
      },
    };
  }

  if (normalized === "run") {
    const [runToolName, ...jsonTokens] = rest;
    if (!runToolName) {
      throw new Error("Usage: run <tool> [json]");
    }

    const runTool = toolsByName.get(runToolName) || findTool(runToolName, tools);
    if (!runTool) {
      throw new Error(`Unknown tool "${runToolName}".`);
    }

    const jsonText = jsonTokens.join(" ").trim();
    const args = jsonText ? JSON.parse(jsonText) : {};
    return { type: "invoke", tool: runTool, args };
  }

  if (rest.length > 0) {
    const jsonText = rest.join(" ").trim();
    const args = jsonText ? JSON.parse(jsonText) : {};
    return { type: "invoke", tool, args };
  }

  return { type: "invoke", tool, args: {} };
}

/**
 * @param {{ subcommand?: string, args: string[] }} command
 */
async function runDsaCommand(command) {
  const subcommand = command.subcommand;
  const args = command.args;

  if (!subcommand || subcommand === "help") {
    return [
      "Instadapp DSA commands (requires DSA_PRIVATE_KEY or MNEMONIC_PHRASE):",
      "  dsa accounts",
      "  dsa build",
      "  dsa build-chains",
      "  dsa recipes",
      "  dsa scan",
      "  dsa gas",
      "  dsa encode <json-spells>",
      '  dsa cast <json-spells> [--build]',
      "",
      "DSA uses DSA_PRIVATE_KEY (EOA owner). DSA authority is the Avocado safe; gas is paid from the USDC gas tank.",
      "dsa-connect targets Base mainnet (8453), not Base Sepolia.",
      "Example:",
      '  dsa cast \'[{"connector":"BASIC-A","method":"deposit","args":["0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE","1000000000000000000",0,0]}]\' --build',
    ].join("\n");
  }

  if (subcommand === "recipes" || subcommand === "recipe") {
    if (subcommand === "recipes") {
      return JSON.stringify(instadapp.listRecipes(), null, 2);
    }

    const [name, ...recipeArgs] = args;
    const params = {};
    for (let i = 0; i < recipeArgs.length; i += 1) {
      if (recipeArgs[i] === "--amountWei" && recipeArgs[i + 1]) {
        params.amountWei = recipeArgs[i + 1];
        i += 1;
      }
    }
    return JSON.stringify(instadapp.buildRecipe(name, params), null, 2);
  }

  const { dsa, web3, chainId, signerAddress } = instadapp.createDsaClient();
  const autoBuild = args.includes("--build");
  const jsonText = args.filter((token) => token !== "--build").join(" ").trim();

  if (subcommand === "build") {
    const authorityAddress = await instadapp.resolveDsaAuthorityAddress();
    const buildResult = await instadapp.buildDsaAccount(dsa, web3, { chainId, signerAddress });
    const txHash = buildResult.txHash;
    const accounts = await instadapp.listDsaAccounts(dsa, authorityAddress);
    const instance = accounts[0] ? await dsa.setInstance(accounts[0].id) : null;
    if (instance) {
      instadapp.saveDsaChainState(
        chainId,
        {
          dsaId: instance.id,
          dsaAddress: instance.address,
          lastBuildTx: txHash,
        },
        signerAddress,
      );
    }
    return JSON.stringify(
      { txHash, gasFunding: buildResult.gasFunding, authorityAddress, accounts },
      null,
      2,
    );
  }

  if (subcommand === "build-chains") {
    const result = await instadapp.buildDsaAccountsForChains();
    return JSON.stringify(result, null, 2);
  }

  if (subcommand === "scan") {
    const opportunities = await instadapp.scanOpportunities();
    return JSON.stringify({ opportunities, count: opportunities.length }, null, 2);
  }

  if (subcommand === "gas") {
    const gasStatus = await instadapp.getDsaGasStatus(signerAddress, chainId);
    const authorityAddress = await instadapp.resolveDsaAuthorityAddress();
    return JSON.stringify(
      {
        ownerAddress: signerAddress,
        authorityAddress,
        chainId,
        chain: instadapp.formatChainLabel(chainId),
        ...gasStatus,
      },
      null,
      2,
    );
  }

  if (subcommand === "accounts") {
    const authorityAddress = await instadapp.resolveDsaAuthorityAddress();
    const accounts = await instadapp.listDsaAccounts(dsa, authorityAddress);
    return JSON.stringify(
      { ownerAddress: signerAddress, authorityAddress, chainId, accounts },
      null,
      2,
    );
  }

  if (subcommand === "encode" || subcommand === "cast") {
    if (!jsonText) {
      throw new Error(`Usage: dsa ${subcommand} '<json-spells>' [--build]`);
    }

    instadapp.parseSpellsInput(jsonText);
    const ensured = await instadapp.ensureDsaInstance(dsa, web3, signerAddress, {
      autoBuild,
      chainId,
    });
    const result = await instadapp.castSpells(dsa, web3, jsonText, {
      dryRun: subcommand === "encode",
    });

    return JSON.stringify(
      {
        dsa: ensured.instance,
        createdDsa: ensured.created,
        ...result,
      },
      null,
      2,
    );
  }

  throw new Error(`Unknown dsa subcommand "${subcommand}". Type "dsa help".`);
}

/**
 * Initializes AgentKit and the focused LangChain tool set.
 */
async function initializeToolkit() {
  const credentials = resolveCdpCredentials();
  const existingWalletData = loadWalletData();
  const walletCreated = !existingWalletData;

  const { walletProvider, walletMode, paymasterUrl } = await createWalletProvider(
    credentials,
    existingWalletData,
  );

  if (walletCreated || walletMode === "smart" || (walletMode === "legacy" && !isLegacyWalletData(existingWalletData))) {
    await persistWallet(walletProvider);
  }

  const cdpConfig = {
    apiKeyId: credentials.apiKeyId,
    apiKeySecret: credentials.apiKeySecretLegacy,
  };

  const actionProviders = [walletActionProvider(), erc721ActionProvider()];

  if (walletMode === "legacy") {
    actionProviders.push(legacyCdpWalletActionProvider(cdpConfig));
  } else if (walletMode === "smart") {
    actionProviders.push(cdpSmartWalletActionProvider());
  } else {
    actionProviders.push(cdpApiActionProvider());
  }

  const agentKit = await AgentKit.from({
    walletProvider,
    actionProviders,
  });

  const focusedToolNames =
    walletMode === "legacy"
      ? new Set(["deploy_token", "mint", "get_wallet_details"])
      : walletMode === "smart"
        ? new Set(["mint", "get_wallet_details", "native_transfer"])
        : new Set(["mint", "get_wallet_details", "request_faucet_funds"]);

  const allTools = await getLangChainTools(agentKit);
  const tools = allTools.filter((tool) =>
    [...focusedToolNames].some(
      (name) => tool.name === name || tool.name.endsWith(`_${name}`),
    ),
  );

  if (tools.length === 0) {
    throw new Error(
      `No focused tools were registered for the active wallet mode. Expected one of: ${[...focusedToolNames].join(", ")}.`,
    );
  }

  const toolsByName = indexTools(tools);

  console.log("Wallet mode:", walletMode);
  console.log("Registered tools:", tools.map((tool) => tool.name).join(", "));
  console.log("Wallet address:", walletProvider.getAddress());
  console.log("Network:", walletProvider.getNetwork().networkId);
  if (walletMode === "smart") {
    console.log("Owner address:", walletProvider.ownerAccount.address);
    console.log("Base Paymaster:", paymasterUrl ? "enabled" : "disabled");
  }

  return { tools, toolsByName, walletProvider, walletMode };
}

/**
 * Runs an interactive REPL loop for invoking AgentKit tools directly.
 *
 * @param {Awaited<ReturnType<typeof initializeToolkit>>["tools"]} tools
 * @param {Awaited<ReturnType<typeof initializeToolkit>>["toolsByName"]} toolsByName
 * @param {Awaited<ReturnType<typeof initializeToolkit>>["walletProvider"]} walletProvider
 */
async function runRepl(tools, toolsByName, walletProvider) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt) =>
    new Promise((resolve) => rl.question(prompt, resolve));

  console.log("\nCDP AgentKit CLI ready on Base Sepolia.");
  console.log("Type a command, or 'help' / 'exit'.\n");

  try {
    while (true) {
      const userInput = (await question("Prompt> ")).trim();

      if (!userInput) {
        continue;
      }

      if (userInput.toLowerCase() === "exit") {
        break;
      }

      console.log("-------------------");

      try {
        const command = parseCommandInput(userInput, tools, toolsByName);

        if (!command) {
          continue;
        }

        if (command.type === "help") {
          printHelp(tools);
          console.log("-------------------\n");
          continue;
        }

        if (command.type === "dsa") {
          const result = await runDsaCommand(command);
          console.log(`\n${result}`);
          console.log("-------------------\n");
          continue;
        }

        const result = await command.tool.invoke(command.args);
        console.log(`\n${result}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
      }

      console.log("-------------------\n");
    }
  } finally {
    rl.close();
    try {
      await persistWallet(walletProvider);
    } catch (err) {
      console.warn(`Warning: could not save wallet state: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function main() {
  validateEnvironment();

  const { tools, toolsByName, walletProvider } = await initializeToolkit();
  await runRepl(tools, toolsByName, walletProvider);
}

module.exports = {
  findTool,
  indexTools,
  isLegacyWalletData,
  isLegacyWalletEnabled,
  parseCommandInput,
  resolveCdpCredentials,
  runDsaCommand,
  validateEnvironment,
};

if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
