const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const dotenv = require("dotenv");
const { HumanMessage } = require("@langchain/core/messages");
const { MemorySaver } = require("@langchain/langgraph-checkpoint");
const { createReactAgent } = require("@langchain/langgraph/prebuilt");
const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
const {
  AgentKit,
  CdpEvmWalletProvider,
  walletActionProvider,
  cdpApiActionProvider,
  legacyCdpWalletActionProvider,
  erc721ActionProvider,
  LegacyCdpWalletProvider,
} = require("@coinbase/agentkit");
const { getLangChainTools } = require("@coinbase/agentkit-langchain");

dotenv.config();

const WALLET_DATA_PATH = path.join(__dirname, "wallet_data.txt");
const NETWORK_ID = "base-sepolia";

/**
 * Resolves CDP credentials from the supported environment variables only.
 *
 * @returns {{ apiKeyId: string, apiKeySecretLegacy: string, apiKeySecretV2: string, walletSecret: string }}
 */
function resolveCdpCredentials() {
  const apiKeyId = process.env.CDP_API_KEY;
  const apiKeySecretRaw = process.env.CDP_PRIVATE_KEY;
  const walletSecret = process.env.CDP_WALLET_SECRET;

  if (!apiKeyId || !apiKeySecretRaw || !walletSecret) {
    throw new Error(
      "Missing CDP credentials. Set CDP_API_KEY, CDP_PRIVATE_KEY, and CDP_WALLET_SECRET.",
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
 * Validates required environment variables.
 */
function validateEnvironment() {
  const missing = [];

  if (!process.env.CDP_API_KEY) {
    missing.push("CDP_API_KEY");
  }
  if (!process.env.CDP_PRIVATE_KEY) {
    missing.push("CDP_PRIVATE_KEY");
  }
  if (!process.env.CDP_WALLET_SECRET) {
    missing.push("CDP_WALLET_SECRET");
  }
  if (!process.env.GEMINI_API_KEY) {
    missing.push("GEMINI_API_KEY");
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
 * Creates the wallet provider, preferring CDP v2 when possible and falling back to legacy for deploy_token support.
 *
 * @param {ReturnType<typeof resolveCdpCredentials>} credentials
 * @param {object|undefined} existingWalletData
 */
async function createWalletProvider(credentials, existingWalletData) {
  const { apiKeyId, apiKeySecretLegacy, apiKeySecretV2, walletSecret } = credentials;

  if (existingWalletData?.address && !existingWalletData?.walletId) {
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
 * Initializes AgentKit, LangChain tools, and the Gemini-powered react agent.
 */
async function initializeAgent() {
  const credentials = resolveCdpCredentials();
  const existingWalletData = loadWalletData();
  const walletCreated = !existingWalletData;

  const { walletProvider, walletMode } = await createWalletProvider(
    credentials,
    existingWalletData,
  );

  if (walletCreated) {
    await persistWallet(walletProvider);
  }

  const cdpConfig = {
    apiKeyId: credentials.apiKeyId,
    apiKeySecret: credentials.apiKeySecretLegacy,
  };

  const actionProviders = [walletActionProvider(), erc721ActionProvider()];

  if (walletMode === "legacy") {
    actionProviders.push(legacyCdpWalletActionProvider(cdpConfig));
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
      : new Set(["mint", "get_wallet_details", "request_faucet_funds"]);

  const allTools = await getLangChainTools(agentKit);
  const tools = allTools.filter((tool) => focusedToolNames.has(tool.name));

  if (tools.length === 0) {
    throw new Error(
      `No focused tools were registered for the active wallet mode. Expected one of: ${[...focusedToolNames].join(", ")}.`,
    );
  }

  const llm = new ChatGoogleGenerativeAI({
    model: "gemini-2.0-flash",
    apiKey: process.env.GEMINI_API_KEY,
    temperature: 0.2,
  });

  const memory = new MemorySaver();
  const agentConfig = { configurable: { thread_id: "cdp-agentkit-gemini-cli" } };

  const agent = createReactAgent({
    llm,
    tools,
    checkpointer: memory,
    prompt: `You are a helpful onchain agent powered by Coinbase CDP AgentKit on Base Sepolia.
You can mint ERC-721 NFTs with mint (also referred to as mint_token).
${
  walletMode === "legacy"
    ? "You can deploy ERC-20 tokens with deploy_token."
    : "You can request Base Sepolia test funds with request_faucet_funds."
}
Before your first onchain action, call get_wallet_details to confirm the wallet address and network.
Be concise, accurate, and explain transaction results clearly.`,
  });

  console.log("Wallet mode:", walletMode);
  console.log("Registered tools:", tools.map((tool) => tool.name).join(", "));
  console.log("Wallet address:", walletProvider.getAddress());
  console.log("Network:", walletProvider.getNetwork().networkId);

  return { agent, agentConfig, walletProvider };
}

/**
 * Runs an interactive REPL loop for chatting with the agent.
 *
 * @param {Awaited<ReturnType<typeof initializeAgent>>["agent"]} agent
 * @param {Awaited<ReturnType<typeof initializeAgent>>["agentConfig"]} agentConfig
 * @param {Awaited<ReturnType<typeof initializeAgent>>["walletProvider"]} walletProvider
 */
async function runRepl(agent, agentConfig, walletProvider) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt) =>
    new Promise((resolve) => rl.question(prompt, resolve));

  console.log("\nCDP AgentKit CLI ready on Base Sepolia.");
  console.log("Type your prompt, or 'exit' to quit.\n");

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

      const stream = await agent.stream(
        { messages: [new HumanMessage(userInput)] },
        agentConfig,
      );

      for await (const chunk of stream) {
        if ("agent" in chunk) {
          const messages = chunk.agent?.messages || [];
          const lastMessage = messages[messages.length - 1];
          if (lastMessage?.content) {
            console.log(`\nAgent: ${lastMessage.content}`);
          }
        }

        if ("tools" in chunk) {
          const messages = chunk.tools?.messages || [];
          for (const toolMessage of messages) {
            console.log(`Tool [${toolMessage.name}]: ${toolMessage.content}`);
          }
        }
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

  const { agent, agentConfig, walletProvider } = await initializeAgent();
  await runRepl(agent, agentConfig, walletProvider);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
