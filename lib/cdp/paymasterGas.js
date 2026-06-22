const fs = require("fs");
const path = require("path");

const { CdpSmartWalletProvider } = require("@coinbase/agentkit");
const { generateJwt } = require("@coinbase/cdp-sdk/auth");
const { createPublicClient, http } = require("viem");
const { arbitrum, base, baseSepolia, optimism, polygon } = require("viem/chains");

const { resolveCdpCredentials } = require("./credentials");

const WALLET_DATA_PATH = path.join(process.cwd(), "wallet_data.txt");

const CHAIN_ID_TO_NETWORK_ID = {
  8453: "base-mainnet",
  84532: "base-sepolia",
  42161: "arbitrum-mainnet",
  137: "polygon-mainnet",
  10: "optimism-mainnet",
};

const VIEM_CHAINS = {
  8453: base,
  84532: baseSepolia,
  42161: arbitrum,
  137: polygon,
  10: optimism,
};

const DEFAULT_RPC_URLS = {
  8453: "https://mainnet.base.org",
  84532: "https://sepolia.base.org",
  42161: "https://arb1.arbitrum.io/rpc",
  137: "https://polygon-bor-rpc.publicnode.com",
  10: "https://mainnet.optimism.io",
};

/** Minimum native balance to keep on the DSA EOA after funding (wei). */
const DEFAULT_MIN_BALANCE_WEI = 500_000_000_000_000n; // 0.0005 ETH

/**
 * @param {number} chainId
 */
function chainIdToNetworkId(chainId) {
  const networkId = CHAIN_ID_TO_NETWORK_ID[chainId];
  if (!networkId) {
    throw new Error(`Chain ${chainId} is not supported by CDP Smart Wallet paymaster funding.`);
  }
  return networkId;
}

/**
 * @param {number} chainId
 */
function resolveChainRpcUrl(chainId) {
  const networkId = chainIdToNetworkId(chainId);
  const envKey = `RPC_URL_${chainId}`;
  return process.env[envKey] || process.env.DSA_RPC_URL || process.env.RPC_URL || DEFAULT_RPC_URLS[chainId];
}

/**
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
    throw new Error(`Failed to resolve CDP Paymaster URL (${response.status}).`);
  }

  const { id } = await response.json();
  return `${basePath}/rpc/v1/${paymasterNetwork}/${id}`;
}

/**
 * @returns {object|undefined}
 */
function loadWalletData() {
  if (!fs.existsSync(WALLET_DATA_PATH)) {
    return undefined;
  }

  const raw = fs.readFileSync(WALLET_DATA_PATH, "utf8").trim();
  if (!raw) {
    return undefined;
  }

  return JSON.parse(raw);
}

/**
 * Creates a CDP Smart Wallet provider with paymaster on the target network.
 *
 * @param {number} chainId
 */
async function createPaymasterWalletProvider(chainId) {
  const credentials = resolveCdpCredentials();
  const networkId = chainIdToNetworkId(chainId);
  const existingWalletData = loadWalletData();
  const paymasterUrl = await resolveBasePaymasterUrl(credentials, networkId);

  const walletProvider = await CdpSmartWalletProvider.configureWithWallet({
    apiKeyId: credentials.apiKeyId,
    apiKeySecret: credentials.apiKeySecretV2,
    walletSecret: credentials.walletSecret,
    networkId,
    rpcUrl: resolveChainRpcUrl(chainId),
    paymasterUrl,
    owner: existingWalletData?.ownerAddress || existingWalletData?.address,
    address: existingWalletData?.ownerAddress ? existingWalletData.address : undefined,
    smartAccountName: existingWalletData?.ownerAddress ? existingWalletData.name : undefined,
  });

  return { walletProvider, paymasterUrl, networkId };
}

/**
 * @param {string} address
 * @param {number} chainId
 */
async function getNativeBalanceWei(address, chainId) {
  const networkId = chainIdToNetworkId(chainId);
  const chain = VIEM_CHAINS[chainId];
  if (!chain) {
    throw new Error(`No viem chain mapping for ${chainId} (${networkId}).`);
  }

  const client = createPublicClient({
    chain,
    transport: http(resolveChainRpcUrl(chainId)),
  });

  return client.getBalance({ address });
}

/**
 * Funds an EOA from the CDP Smart Wallet using paymaster-sponsored gas.
 *
 * @param {string} recipientAddress DSA EOA signer
 * @param {bigint} amountWei
 * @param {number} chainId
 */
async function fundEoaFromPaymaster(recipientAddress, amountWei, chainId) {
  const { walletProvider, paymasterUrl, networkId } = await createPaymasterWalletProvider(chainId);
  const smartWalletBalance = await walletProvider.getBalance();

  if (smartWalletBalance < amountWei) {
    throw new Error(
      `CDP Smart Wallet ${walletProvider.getAddress()} on ${networkId} has ` +
        `${smartWalletBalance} wei but ${amountWei} wei is required to fund the DSA EOA. ` +
        "The paymaster sponsors transaction gas, but the smart wallet still needs native ETH/POL " +
        "for the transfer amount. Send native tokens to the smart wallet address first.",
    );
  }

  const userOpHash = await walletProvider.nativeTransfer(recipientAddress, amountWei.toString());
  const receipt = await walletProvider.waitForTransactionReceipt(userOpHash);

  return {
    funded: true,
    recipientAddress,
    amountWei: amountWei.toString(),
    chainId,
    networkId,
    smartWalletAddress: walletProvider.getAddress(),
    paymasterUrl,
    userOpHash,
    transactionHash: receipt.transactionHash,
  };
}

/**
 * Ensures the DSA EOA has enough native gas, funding from CDP paymaster when needed.
 *
 * @param {string} signerAddress
 * @param {number} chainId
 * @param {bigint} requiredWei
 * @param {{ minBalanceWei?: bigint, force?: boolean }} [options]
 */
async function ensureEoaGas(signerAddress, chainId, requiredWei, options = {}) {
  if (process.env.DSA_USE_PAYMASTER === "0" || process.env.DSA_USE_PAYMASTER === "false") {
    const balanceWei = await getNativeBalanceWei(signerAddress, chainId);
    return {
      funded: false,
      paymaster: false,
      signerAddress,
      chainId,
      balanceWei: balanceWei.toString(),
      requiredWei: requiredWei.toString(),
      sufficient: balanceWei >= requiredWei,
    };
  }

  const minBalanceWei = options.minBalanceWei ?? DEFAULT_MIN_BALANCE_WEI;
  const targetBalance = requiredWei > minBalanceWei ? requiredWei : minBalanceWei;
  const balanceWei = await getNativeBalanceWei(signerAddress, chainId);

  if (!options.force && balanceWei >= targetBalance) {
    return {
      funded: false,
      paymaster: true,
      signerAddress,
      chainId,
      balanceWei: balanceWei.toString(),
      requiredWei: requiredWei.toString(),
      targetBalance: targetBalance.toString(),
      sufficient: true,
    };
  }

  const deficit = targetBalance > balanceWei ? targetBalance - balanceWei : targetBalance;
  const fundResult = await fundEoaFromPaymaster(signerAddress, deficit, chainId);
  const newBalance = await getNativeBalanceWei(signerAddress, chainId);

  return {
    ...fundResult,
    paymaster: true,
    sufficient: newBalance >= requiredWei,
    balanceWei: newBalance.toString(),
    requiredWei: requiredWei.toString(),
    targetBalance: targetBalance.toString(),
    previousBalanceWei: balanceWei.toString(),
  };
}

module.exports = {
  chainIdToNetworkId,
  createPaymasterWalletProvider,
  ensureEoaGas,
  fundEoaFromPaymaster,
  getNativeBalanceWei,
  resolveBasePaymasterUrl,
};
