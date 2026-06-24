/** Aave V3, Compound V3, and Uniswap V3 addresses for L2 searcher flows. */
const PROTOCOLS = {
  8453: {
    aaveV3Pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    aaveV3PoolDataProvider: "0x2d8A3C5677189723c4cB8873CfC96C0E048f0703",
    compoundV3Usdc: "0xb125E6687d4313864eB53dffDB2bbb97b7bb5E94",
    uniswapV3QuoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    instaFlashAggregator: "0x3813f7a28814bfaf861192d0a5a4891b15698bac",
    flashloanRoute: 5,
  },
  42161: {
    aaveV3Pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    aaveV3PoolDataProvider: "0x69FA688f1Dc47d4B5d8029D5a8FE2482daF5BaA3",
    compoundV3Usdc: "0xA5ED3DDfCaf4fF7921134781749D4b268Ee0dA65",
    uniswapV3QuoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    instaFlashAggregator: "0x1f882522DF99820dF8e586b6df8bAae2b91a782d",
    flashloanRoute: 5,
  },
  137: {
    aaveV3Pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    aaveV3PoolDataProvider: "0x69FA688f1Dc47d4B5d8029D5a8FE2482daF5BaA3",
    compoundV3Usdc: "0xF25212E676D1F7F89D72bEe8AEf78bae4A3eDA8",
    uniswapV3QuoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    flashloanRoute: 1,
  },
  10: {
    aaveV3Pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    aaveV3PoolDataProvider: "0x69FA688f1Dc47d4B5d8029D5a8FE2482daF5BaA3",
    compoundV3Usdc: "0xb125E6687d4313864eB53dffDB2bbb97b7bb5E94",
    uniswapV3QuoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    flashloanRoute: 8,
  },
};

const AAVE_POOL_ABI = [
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserAccountData",
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
];

const COMPOUND_V3_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "isLiquidatable",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
];

const UNISWAP_QUOTER_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        name: "params",
        type: "tuple",
      },
    ],
    name: "quoteExactInputSingle",
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
];

/** Default Aave flash-loan premium buffer in basis points. */
const DEFAULT_FLASHLOAN_FEE_BPS = 9;

/**
 * @param {number} chainId
 */
function getProtocolAddresses(chainId) {
  const config = PROTOCOLS[chainId];
  if (!config) {
    throw new Error(`Protocols are not configured for chain ${chainId}.`);
  }
  return config;
}

/**
 * @param {bigint | string | number} amountWei
 * @param {number} [feeBps]
 */
function applyFlashloanFee(amountWei, feeBps = DEFAULT_FLASHLOAN_FEE_BPS) {
  const amount = BigInt(amountWei);
  return (amount * BigInt(10_000 + feeBps)) / 10_000n;
}

module.exports = {
  AAVE_POOL_ABI,
  COMPOUND_V3_ABI,
  DEFAULT_FLASHLOAN_FEE_BPS,
  PROTOCOLS,
  UNISWAP_QUOTER_ABI,
  applyFlashloanFee,
  getProtocolAddresses,
};
