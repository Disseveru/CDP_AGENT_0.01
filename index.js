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
  LegacyCdpWalletProvider,
  walletActionProvider,
  legacyCdpWalletActionProvider,
  erc721ActionProvider,
} = require("@coinbase/agentkit");
const { getLangChainTools } = require("@coinbase/agentkit-langchain");

dotenv.config();

const WALLET_DATA_PATH = path.join(__dirname, "wallet_data.txt");
const NETWORK_ID = "base-sepolia";
const FOCUSED_TOOL_NAMES = new Set(["deploy_token", "mint", "get_wallet_details"]);

/**
 * Formats CDP API private key material for the legacy Coinbase SDK.
 * Cloud environments often inject EC PEM keys as a single line.
 *
 * @param {string|undefined} key
 * @returns {string|undefined}
 */
function formatApiKeySecret(key) {
  if (!key) {
    return undefined;
  }

  const pem = key.replace(/\\n/g, "\n").trim();

  if (pem.includes("\n")) {
    return pem;
  }

  const match = pem.match(/-----BEGIN ([^-]+)-----(.*?)-----END \1-----/);
  if (!match) {
    return pem;
  }

  const [, type, body] = match;
  const cleanBody = body.replace(/\s+/g, "");
  const lines = cleanBody.match(/.{1,64}/g) || [];

  return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----`;
}

/**
 * Resolves CDP API credentials from supported environment variable names.
 *
 * @returns {{ apiKeyId: string, apiKeySecret: string }}
 */
function getCdpCredentials() {
  const apiKeyId = process.env.CDP_API_KEY || process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_PRIVATE_KEY || process.env.CDP_API_KEY_SECRET;

  return { apiKeyId, apiKeySecret };
}

/**
 * Validates required environment variables.
 */
function validateEnvironment() {
  const missing = [];
  const { apiKeyId, apiKeySecret } = getCdpCredentials();

  if (!apiKeyId) {
    missing.push("CDP_API_KEY or CDP_API_KEY_ID");
  }
  if (!apiKeySecret) {
    missing.push("CDP_PRIVATE_KEY or CDP_API_KEY_SECRET");
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
 * @returns {string|undefined}
 */
function loadWalletData() {
  if (!fs.existsSync(WALLET_DATA_PATH)) {
    return undefined;
  }

  return fs.readFileSync(WALLET_DATA_PATH, "utf8").trim();
}

/**
 * Persists wallet export data for local reuse across sessions.
 *
 * @param {import("@coinbase/agentkit").LegacyCdpWalletProvider} walletProvider
 */
async function persistWallet(walletProvider) {
  const walletData = await walletProvider.exportWallet();
  fs.writeFileSync(WALLET_DATA_PATH, JSON.stringify(walletData, null, 2));
  console.log(`Wallet state saved to ${WALLET_DATA_PATH}`);
}

/**
 * Initializes AgentKit, LangChain tools, and the Gemini-powered react agent.
 */
async function initializeAgent() {
  const existingWalletData = loadWalletData();
  const walletCreated = !existingWalletData;
  const { apiKeyId, apiKeySecret: rawApiKeySecret } = getCdpCredentials();
  const apiKeySecret = formatApiKeySecret(rawApiKeySecret);

  const walletProvider = await LegacyCdpWalletProvider.configureWithWallet({
    apiKeyId,
    apiKeySecret,
    networkId: NETWORK_ID,
    cdpWalletData: existingWalletData,
  });

  if (walletCreated) {
    await persistWallet(walletProvider);
  }

  const cdpConfig = {
    apiKeyId,
    apiKeySecret,
  };

  const agentKit = await AgentKit.from({
    walletProvider,
    actionProviders: [
      walletActionProvider(),
      legacyCdpWalletActionProvider(cdpConfig),
      erc721ActionProvider(),
    ],
  });

  const allTools = await getLangChainTools(agentKit);
  const tools = allTools.filter((tool) => FOCUSED_TOOL_NAMES.has(tool.name));

  if (tools.length === 0) {
    throw new Error("No focused tools were registered. Expected deploy_token and mint.");
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
You can deploy ERC-20 tokens with deploy_token and mint ERC-721 NFTs with mint (also referred to as mint_token).
Before your first onchain action, call get_wallet_details to confirm the wallet address and network.
If funds are needed on Base Sepolia, ask the user to fund the wallet or use a faucet.
Be concise, accurate, and explain transaction results clearly.`,
  });

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
    await persistWallet(walletProvider);
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
