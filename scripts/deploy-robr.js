#!/usr/bin/env node
/**
 * Deploy $RObR on Base mainnet — tries CDP Smart Wallet + paymaster, then Avocado gas tank.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const dotenv = require("dotenv");
const { encodeFunctionData, parseEventLogs, createPublicClient, http } = require("viem");
const { base } = require("viem/chains");
const { Clanker } = require("clanker-sdk/v4");
const { generateJwt } = require("@coinbase/cdp-sdk/auth");
const { CdpClient } = require("@coinbase/cdp-sdk");
const { CdpSmartWalletProvider } = require("@coinbase/agentkit");

const {
  createAvocadoWallet,
  ensureAvocadoGasForAddress,
} = require("../lib/instadapp/avocadoWallet");
const { resolveSigningKey } = require("../lib/instadapp/keys");
const { resolveCdpCredentials } = require("../index");

dotenv.config();

const WALLET_DATA_PATH = path.join(__dirname, "..", "wallet_data.txt");
const SAFE_ADDRESS = process.env.AVOCADO_SAFE_ADDRESS || "0xfd6C286dF0126f5D329526996242738d7200B40C";
const CHAIN_ID = 8453;
const NETWORK_ID = "base-mainnet";
const TWEET_URL = "https://x.com/elonmusk/status/2069089477511790812";
const TOKEN_NAME = "Ro the Robber";
const TOKEN_SYMBOL = "RObR";
const CDP_UNAUTHORIZED_ERROR =
  "Unauthorized CDP API credentials. Verify CDP_API_KEY/CDP_PRIVATE_KEY/CDP_WALLET_SECRET in the Coinbase Developer Platform dashboard.";

function loadWalletData() {
  if (!fs.existsSync(WALLET_DATA_PATH)) return undefined;
  const raw = fs.readFileSync(WALLET_DATA_PATH, "utf8").trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `Invalid wallet_data.txt format. Delete ${WALLET_DATA_PATH} to reset wallet state and force a fresh initialization on the next run.`,
    );
  }
}

async function resolvePaymasterUrl(credentials) {
  if (process.env.PAYMASTER_URL) return process.env.PAYMASTER_URL;
  const jwt = await generateJwt({
    apiKeyId: credentials.apiKeyId,
    apiKeySecret: credentials.apiKeySecretV2,
    requestMethod: "GET",
    requestHost: "api.cdp.coinbase.com",
    requestPath: "/apikeys/v1/tokens/active",
  });
  const response = await fetch("https://api.cdp.coinbase.com/apikeys/v1/tokens/active", {
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
  });
  if (response.status === 401) {
    throw new Error(CDP_UNAUTHORIZED_ERROR);
  }
  if (!response.ok) throw new Error(`Paymaster URL lookup failed (${response.status})`);
  const { id } = await response.json();
  return `https://api.cdp.coinbase.com/rpc/v1/base/${id}`;
}

async function createSmartWallet(credentials, existingWalletData, paymasterUrl) {
  const ownerAddress = existingWalletData?.ownerAddress || existingWalletData?.address;
  let smartWalletAddress = existingWalletData?.ownerAddress ? existingWalletData.address : undefined;

  if (!smartWalletAddress && ownerAddress) {
    const cdpClient = new CdpClient({
      apiKeyId: credentials.apiKeyId,
      apiKeySecret: credentials.apiKeySecretV2,
      walletSecret: credentials.walletSecret,
    });
    const page = await cdpClient.evm.listSmartAccounts();
    const match = page.accounts.find((account) =>
      account.owners?.some((owner) => owner.toLowerCase() === ownerAddress.toLowerCase()),
    );
    smartWalletAddress = match?.address;
  }

  return CdpSmartWalletProvider.configureWithWallet({
    apiKeyId: credentials.apiKeyId,
    apiKeySecret: credentials.apiKeySecretV2,
    walletSecret: credentials.walletSecret,
    networkId: NETWORK_ID,
    rpcUrl: "https://mainnet.base.org",
    paymasterUrl,
    owner: ownerAddress,
    address: smartWalletAddress,
    smartAccountName: existingWalletData?.ownerAddress ? existingWalletData.name : undefined,
  });
}

function buildTokenConfig(tokenAdmin) {
  return {
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    image: "https://pbs.twimg.com/profile_images/2053244804520427520/m8mdWZCG_200x200.jpg",
    metadata: {
      description: `${TOKEN_NAME} ($${TOKEN_SYMBOL}) — Elon Musk: "Ro the Robber" ${TWEET_URL}`,
      socialMediaUrls: [{ platform: "x", url: TWEET_URL }],
    },
    context: { interface: "CDP AgentKit", id: "elonmusk" },
    tokenAdmin,
    chainId: CHAIN_ID,
  };
}

async function encodeClankerDeploy(tokenAdmin) {
  const publicClient = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
  const clanker = new Clanker({ publicClient });
  const deployTx = await clanker.getDeployTransaction(buildTokenConfig(tokenAdmin));
  const data = encodeFunctionData({
    abi: deployTx.abi,
    functionName: deployTx.functionName,
    args: deployTx.args,
  });
  return { deployTx, data, publicClient };
}

async function waitForToken(publicClient, deployTx, txHash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  const logs = parseEventLogs({
    abi: deployTx.abi,
    eventName: "TokenCreated",
    logs: receipt.logs,
  });
  if (!logs.length) {
    throw new Error(`No TokenCreated event in tx ${txHash}`);
  }
  return logs[0].args.tokenAddress;
}

async function deployViaPaymaster() {
  const credentials = resolveCdpCredentials();
  const paymasterUrl = await resolvePaymasterUrl(credentials);
  const existingWalletData = loadWalletData();
  const walletProvider = await createSmartWallet(credentials, existingWalletData, paymasterUrl);
  const admin = walletProvider.getAddress();

  console.log("Paymaster path — smart wallet:", admin);
  const { deployTx, data, publicClient } = await encodeClankerDeploy(admin);

  const cdpClient = new CdpClient({
    apiKeyId: credentials.apiKeyId,
    apiKeySecret: credentials.apiKeySecretV2,
    walletSecret: credentials.walletSecret,
  });
  const owner = await cdpClient.evm.getAccount({
    address: walletProvider.ownerAccount.address,
  });
  const smartAccount = await cdpClient.evm.getSmartAccount({ address: admin, owner });

  const { userOpHash } = await cdpClient.evm.sendUserOperation({
    smartAccount,
    network: "base",
    paymasterUrl,
    calls: [{ to: deployTx.address, value: 0n, data, overrideGasLimit: 6_000_000n }],
  });
  console.log("UserOp hash:", userOpHash);

  const receipt = await walletProvider.waitForTransactionReceipt(userOpHash);
  if (receipt.status !== "complete" || !receipt.transactionHash) {
    throw new Error(`Paymaster deploy failed: ${JSON.stringify(receipt)}`);
  }

  const tokenAddress = await waitForToken(publicClient, deployTx, receipt.transactionHash);
  return { tokenAddress, txHash: receipt.transactionHash, broadcaster: "cdp-paymaster", admin };
}

async function deployViaAvocado() {
  const privateKey = resolveSigningKey();
  const { safe, ownerAddress } = createAvocadoWallet(privateKey, SAFE_ADDRESS);
  await ensureAvocadoGasForAddress(SAFE_ADDRESS);

  console.log("Avocado path — safe:", SAFE_ADDRESS, "owner:", ownerAddress);
  const { deployTx, data, publicClient } = await encodeClankerDeploy(SAFE_ADDRESS);

  const avocadoOpts = { safeAddress: SAFE_ADDRESS, version: "2.0.0" };
  const response = await safe.sendTransactions(
    [{ to: deployTx.address, data, value: 0 }],
    CHAIN_ID,
    avocadoOpts,
  );
  const tokenAddress = await waitForToken(publicClient, deployTx, response.hash);
  return { tokenAddress, txHash: response.hash, broadcaster: "avocado", admin: SAFE_ADDRESS };
}

async function main() {
  console.log(`Launching $${TOKEN_SYMBOL} on Base mainnet...\n`);

  let result;
  try {
    result = await deployViaPaymaster();
  } catch (paymasterError) {
    const message =
      paymasterError instanceof Error ? paymasterError.message : String(paymasterError);
    if (message === CDP_UNAUTHORIZED_ERROR || message.startsWith("Invalid wallet_data.txt format.")) {
      throw paymasterError;
    }
    console.warn("Paymaster deploy failed:", message);
    console.log("Falling back to Avocado USDC gas tank...\n");
    result = await deployViaAvocado();
  }

  console.log("\n=== $RObR LIVE ON BASE ===");
  console.log("Name:", TOKEN_NAME);
  console.log("Symbol:", TOKEN_SYMBOL);
  console.log("Admin:", result.admin);
  console.log("Broadcaster:", result.broadcaster);
  console.log("Token:", result.tokenAddress);
  console.log("Tx:", result.txHash);
  console.log("Basescan:", `https://basescan.org/tx/${result.txHash}`);
  console.log("Token:", `https://basescan.org/token/${result.tokenAddress}`);
  console.log("Clanker:", `https://clanker.world/clanker/${result.tokenAddress}`);
  console.log("Tweet:", TWEET_URL);
}

main().catch((error) => {
  console.error("Fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
