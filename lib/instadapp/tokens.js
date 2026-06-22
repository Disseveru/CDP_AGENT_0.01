const { NATIVE_TOKEN } = require("./constants");

/** @type {Record<number, { WETH: string, USDC: string, DAI?: string }>} */
const TOKENS = {
  8453: {
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  },
  42161: {
    WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
  },
  137: {
    WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  },
  10: {
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
  },
};

const DECIMALS = {
  WETH: 18,
  USDC: 6,
  DAI: 18,
};

/**
 * @param {number} chainId
 * @param {string} symbol
 */
function getTokenAddress(chainId, symbol) {
  const upper = symbol.toUpperCase();
  if (upper === "ETH" || upper === "NATIVE") {
    return NATIVE_TOKEN;
  }

  const chainTokens = TOKENS[chainId];
  if (!chainTokens?.[upper]) {
    throw new Error(`Token ${symbol} is not configured for chain ${chainId}.`);
  }

  return chainTokens[upper];
}

/**
 * @param {string} symbol
 */
function getTokenDecimals(symbol) {
  const upper = symbol.toUpperCase();
  if (upper === "ETH" || upper === "NATIVE") {
    return 18;
  }

  const decimals = DECIMALS[upper];
  if (decimals == null) {
    throw new Error(`Decimals unknown for token ${symbol}.`);
  }

  return decimals;
}

module.exports = {
  DECIMALS,
  TOKENS,
  getTokenAddress,
  getTokenDecimals,
};
