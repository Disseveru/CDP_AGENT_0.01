/**
 * Base mainnet blockchain data helpers.
 *
 * Canonical network metadata is sourced from Base docs:
 * - Documentation index: https://docs.base.org/llms.txt
 * - Connecting to Base: https://docs.base.org/base-chain/quickstart/connecting-to-base
 * - Contract addresses: https://docs.base.org/base-chain/network-information/base-contracts
 * - JSON-RPC (eth_call): https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_call
 */

const Web3 = require("web3");

/** @see https://docs.base.org/base-chain/quickstart/connecting-to-base */
const BASE_MAINNET = {
  networkId: "base-mainnet",
  chainId: 8453,
  name: "Base Mainnet",
  rpcUrl: "https://mainnet.base.org",
  currencySymbol: "ETH",
  blockExplorer: "https://base.blockscout.com/",
  docsIndex: "https://docs.base.org/llms.txt",
};

/** Common Base mainnet tokens (CDP SQL + Base ecosystem). */
const BASE_TOKENS = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  NATIVE: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
};

const ERC20_DECIMALS_ABI = [
  {
    constant: true,
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    type: "function",
  },
];

const UNISWAP_V3_POOL_ABI = [
  {
    inputs: [],
    name: "token0",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token1",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "fee",
    outputs: [{ internalType: "uint24", name: "", type: "uint24" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "liquidity",
    outputs: [{ internalType: "uint128", name: "", type: "uint128" }],
    stateMutability: "view",
    type: "function",
  },
];

/**
 * Resolve Base mainnet RPC URL from env, wallet transport, or docs default.
 *
 * @param {import("@coinbase/agentkit").EvmWalletProvider | undefined} [walletProvider]
 */
function resolveBaseMainnetRpcUrl(walletProvider) {
  if (process.env.DSA_RPC_URL) {
    return process.env.DSA_RPC_URL;
  }

  if (process.env.RPC_URL) {
    return process.env.RPC_URL;
  }

  if (walletProvider && typeof walletProvider.getPublicClient === "function") {
    const client = walletProvider.getPublicClient();
    if (client?.transport?.url) {
      return client.transport.url;
    }
  }

  return BASE_MAINNET.rpcUrl;
}

/**
 * @param {import("@coinbase/agentkit").EvmWalletProvider | undefined} walletProvider
 */
function createBaseWeb3(walletProvider) {
  if (walletProvider && typeof walletProvider.getProvider === "function") {
    return new Web3(walletProvider.getProvider());
  }

  return new Web3(new Web3.providers.HttpProvider(resolveBaseMainnetRpcUrl(walletProvider)));
}

/**
 * Read contract state via viem PublicClient (Base docs eth_call) when available.
 *
 * @param {import("viem").PublicClient | undefined} publicClient
 * @param {{ address: `0x${string}`, abi: readonly unknown[], functionName: string, args?: unknown[] }} params
 */
async function readContractViaPublicClient(publicClient, params) {
  if (!publicClient?.readContract) {
    return undefined;
  }

  return publicClient.readContract(params);
}

/**
 * @param {import("web3").Web3} web3
 * @param {string} tokenAddress
 */
async function readTokenDecimals(web3, tokenAddress) {
  const contract = new web3.eth.Contract(ERC20_DECIMALS_ABI, tokenAddress);
  const decimals = await contract.methods.decimals().call();
  return Number(decimals);
}

/**
 * @param {import("web3").Web3} web3
 * @param {string} tokenAddress
 * @param {import("viem").PublicClient | undefined} [publicClient]
 */
async function readTokenDecimalsWithClient(web3, tokenAddress, publicClient) {
  const fromClient = await readContractViaPublicClient(publicClient, {
    address: tokenAddress,
    abi: ERC20_DECIMALS_ABI,
    functionName: "decimals",
  });

  if (fromClient != null) {
    return Number(fromClient);
  }

  return readTokenDecimals(web3, tokenAddress);
}

/**
 * @param {import("web3").Web3} web3
 * @param {string} poolAddress
 * @param {import("viem").PublicClient | undefined} [publicClient]
 */
async function readUniswapV3Pool(web3, poolAddress, publicClient) {
  if (publicClient) {
    const checksummed = Web3.utils.toChecksumAddress(poolAddress);
    const [token0, token1, fee, liquidity] = await Promise.all([
      readContractViaPublicClient(publicClient, {
        address: checksummed,
        abi: UNISWAP_V3_POOL_ABI,
        functionName: "token0",
      }),
      readContractViaPublicClient(publicClient, {
        address: checksummed,
        abi: UNISWAP_V3_POOL_ABI,
        functionName: "token1",
      }),
      readContractViaPublicClient(publicClient, {
        address: checksummed,
        abi: UNISWAP_V3_POOL_ABI,
        functionName: "fee",
      }),
      readContractViaPublicClient(publicClient, {
        address: checksummed,
        abi: UNISWAP_V3_POOL_ABI,
        functionName: "liquidity",
      }),
    ]);

    if (token0 && token1 && fee != null) {
      return {
        token0: Web3.utils.toChecksumAddress(token0),
        token1: Web3.utils.toChecksumAddress(token1),
        fee: Number(fee),
        liquidity: liquidity != null ? String(liquidity) : undefined,
      };
    }
  }

  const pool = new web3.eth.Contract(UNISWAP_V3_POOL_ABI, poolAddress);
  const [token0, token1, fee, liquidity] = await Promise.all([
    pool.methods.token0().call(),
    pool.methods.token1().call(),
    pool.methods.fee().call(),
    pool.methods.liquidity().call().catch(() => undefined),
  ]);

  return {
    token0: Web3.utils.toChecksumAddress(token0),
    token1: Web3.utils.toChecksumAddress(token1),
    fee: Number(fee),
    liquidity: liquidity != null ? String(liquidity) : undefined,
  };
}

/**
 * @param {string} humanAmount
 * @param {number} decimals
 */
function toTokenWei(humanAmount, decimals) {
  const [wholePart, fractionalPart = ""] = humanAmount.split(".");
  if (!/^\d+$/.test(wholePart) || !/^\d*$/.test(fractionalPart)) {
    throw new Error(`Invalid token amount "${humanAmount}".`);
  }

  const paddedFraction = `${fractionalPart}${"0".repeat(decimals)}`.slice(0, decimals);
  const combined = `${wholePart}${paddedFraction}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

/**
 * Instadapp unitAmt formula; slippage is encoded via minReceiveAmount.
 *
 * @see https://docs.instadapp.io/faq/connectors/calculate-unitamt
 */
function calculateUnitAmt(minReceiveWei, sellAmountWei, buyDecimals, sellDecimals) {
  const minReceive = BigInt(minReceiveWei);
  const sellAmount = BigInt(sellAmountWei);

  if (sellAmount === 0n) {
    throw new Error("borrowAmount resolves to zero wei; cannot compute unitAmt.");
  }

  if (minReceive === 0n) {
    throw new Error("minReceiveAmount resolves to zero wei; refusing to swap without protection.");
  }

  const scale = 10n ** 18n;
  const numerator = minReceive * 10n ** BigInt(sellDecimals) * scale;
  const denominator = sellAmount * 10n ** BigInt(buyDecimals);
  return (numerator / denominator).toString();
}

module.exports = {
  BASE_MAINNET,
  BASE_TOKENS,
  ERC20_DECIMALS_ABI,
  UNISWAP_V3_POOL_ABI,
  calculateUnitAmt,
  createBaseWeb3,
  readContractViaPublicClient,
  readTokenDecimals,
  readTokenDecimalsWithClient,
  readUniswapV3Pool,
  resolveBaseMainnetRpcUrl,
  toTokenWei,
};
