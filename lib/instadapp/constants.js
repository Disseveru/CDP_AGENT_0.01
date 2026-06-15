/** Instadapp native-token sentinel used across connectors. */
const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/** Chain IDs supported by dsa-connect@0.7.x */
const SUPPORTED_DSA_CHAIN_IDS = new Set([1, 137, 42161, 43114, 10, 250, 8453, 9745, 56]);

const DEFAULT_DSA_CHAIN_ID = 8453;

const DEFAULT_RPC_URLS = {
  1: "https://eth.llamarpc.com",
  137: "https://polygon-bor-rpc.publicnode.com",
  42161: "https://arb1.arbitrum.io/rpc",
  43114: "https://api.avax.network/ext/bc/C/rpc",
  10: "https://mainnet.optimism.io",
  250: "https://rpc.ftm.tools",
  8453: "https://mainnet.base.org",
  9745: "https://rpc.plasma.chain",
  56: "https://bsc-dataseed.binance.org",
};

const CHAIN_LABELS = {
  1: "ethereum",
  137: "polygon",
  42161: "arbitrum",
  10: "optimism",
  250: "fantom",
  8453: "base",
  9745: "plasma",
  56: "bsc",
  43114: "avalanche",
};

const DSA_DATA_PATH = "dsa_data.json";

module.exports = {
  CHAIN_LABELS,
  DEFAULT_DSA_CHAIN_ID,
  DEFAULT_RPC_URLS,
  DSA_DATA_PATH,
  NATIVE_TOKEN,
  SUPPORTED_DSA_CHAIN_IDS,
};
