const fs = require("fs");
const path = require("path");

const { AAVE_POOL_ABI, COMPOUND_V3_ABI, getProtocolAddresses } = require("./protocols");
const { getTokenAddress } = require("./tokens");
const { createQuoterWeb3, quoteUniswapV3Single } = require("./quoter");

const CONFIG_PATH = path.join(process.cwd(), "dsa_searcher_config.json");

const DEFAULT_CONFIG = {
  chains: [8453, 42161, 137, 10],
  minProfitBps: 8,
  arbitragePairs: [
    {
      label: "base-usdc-weth",
      chainId: 8453,
      tokenIn: "USDC",
      tokenOut: "WETH",
      amountIn: "5000",
      fee: 500,
      minProfitBps: 8,
    },
    {
      label: "arbitrum-usdc-weth",
      chainId: 42161,
      tokenIn: "USDC",
      tokenOut: "WETH",
      amountIn: "5000",
      fee: 500,
      minProfitBps: 8,
    },
  ],
  liquidationPositions: [],
};

/**
 * @returns {typeof DEFAULT_CONFIG}
 */
function loadSearcherConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return DEFAULT_CONFIG;
  }

  const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    arbitragePairs: parsed.arbitragePairs ?? DEFAULT_CONFIG.arbitragePairs,
    liquidationPositions: parsed.liquidationPositions ?? DEFAULT_CONFIG.liquidationPositions,
  };
}

/**
 * @param {bigint} amount
 * @param {number} decimals
 */
function toDecimalString(amount, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const fraction = amount % base;
  if (fraction === 0n) {
    return whole.toString();
  }

  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fractionText}`;
}

/**
 * @param {import("web3").Web3} web3
 * @param {number} chainId
 * @param {string} borrower
 */
async function fetchAaveHealthFactor(web3, chainId, borrower) {
  const { aaveV3Pool } = getProtocolAddresses(chainId);
  const pool = new web3.eth.Contract(AAVE_POOL_ABI, aaveV3Pool);
  const data = await pool.methods.getUserAccountData(borrower).call();
  return {
    healthFactor: Number(data.healthFactor) / 1e18,
    totalCollateralBase: data.totalCollateralBase,
    totalDebtBase: data.totalDebtBase,
  };
}

/**
 * @param {import("web3").Web3} web3
 * @param {number} chainId
 * @param {string} borrower
 * @param {string} cometAddress
 */
async function fetchCompoundLiquidatable(web3, chainId, cometAddress, borrower) {
  const comet = new web3.eth.Contract(COMPOUND_V3_ABI, cometAddress);
  return comet.methods.isLiquidatable(borrower).call();
}

/**
 * @param {object} pair
 */
async function scanArbitragePair(pair) {
  const chainId = Number(pair.chainId);
  const tokenIn = getTokenAddress(chainId, pair.tokenIn);
  const tokenOut = getTokenAddress(chainId, pair.tokenOut);
  const decimalsIn = pair.tokenIn.toUpperCase() === "USDC" ? 6 : 18;
  const amountInWei = BigInt(
    Math.trunc(Number(pair.amountIn) * 10 ** decimalsIn).toString(),
  ).toString();

  const web3 = createQuoterWeb3(chainId);
  const forwardOutWei = await quoteUniswapV3Single(web3, chainId, {
    tokenIn,
    tokenOut,
    amountInWei,
    fee: pair.fee ?? 500,
  });

  const reverseOutWei = await quoteUniswapV3Single(web3, chainId, {
    tokenIn: tokenOut,
    tokenOut: tokenIn,
    amountInWei: forwardOutWei.toString(),
    fee: pair.fee ?? 500,
  });

  const profitWei = reverseOutWei - BigInt(amountInWei);
  if (profitWei <= 0n) {
    return null;
  }

  const profitBps = Number((profitWei * 10_000n) / BigInt(amountInWei));
  const minProfitBps = Number(pair.minProfitBps ?? DEFAULT_CONFIG.minProfitBps);
  if (profitBps < minProfitBps) {
    return null;
  }

  return {
    type: "arbitrage",
    label: pair.label,
    chainId,
    tokenIn,
    tokenOut,
    repayToken: tokenIn,
    flashLoanAmountWei: amountInWei,
    forwardOutWei: forwardOutWei.toString(),
    reverseOutWei: reverseOutWei.toString(),
    profitWei: profitWei.toString(),
    profitBps,
    fee: pair.fee ?? 500,
    profitHuman: toDecimalString(profitWei, decimalsIn),
  };
}

/**
 * @param {object} position
 */
async function scanLiquidationPosition(position) {
  const chainId = Number(position.chainId);
  const web3 = createQuoterWeb3(chainId);
  const protocols = getProtocolAddresses(chainId);

  if (position.protocol === "aave-v3") {
    const stats = await fetchAaveHealthFactor(web3, chainId, position.borrower);
    const threshold = Number(position.liquidationHealthFactor ?? 1);
    if (stats.healthFactor >= threshold) {
      return null;
    }

    return {
      type: "liquidation",
      protocol: "aave-v3",
      label: position.label || `aave-v3:${position.borrower}`,
      chainId,
      borrower: position.borrower,
      healthFactor: stats.healthFactor,
      note: "Aave V3 liquidation spells require a custom connector; monitor only.",
      metadata: stats,
    };
  }

  if (position.protocol === "compound-v3") {
    const market = position.market || protocols.compoundV3Usdc;
    const liquidatable = await fetchCompoundLiquidatable(web3, chainId, market, position.borrower);
    if (!liquidatable) {
      return null;
    }

    const repayToken = position.repayToken || getTokenAddress(chainId, "USDC");
    const collateralToken = position.collateralToken || getTokenAddress(chainId, "WETH");

    return {
      type: "liquidation",
      protocol: "compound-v3",
      label: position.label || `compound-v3:${position.borrower}`,
      chainId,
      borrower: position.borrower,
      market,
      repayToken,
      collateralToken,
      flashLoanAmountWei: position.flashLoanAmountWei || "1000000000",
      collateralReceivedWei: position.collateralReceivedWei,
      fee: position.fee ?? 500,
    };
  }

  return null;
}

/**
 * @param {{ chains?: number[] }} [options]
 */
async function scanOpportunities(options = {}) {
  const config = loadSearcherConfig();
  const chains = options.chains ?? config.chains;
  const opportunities = [];

  for (const pair of config.arbitragePairs) {
    if (!chains.includes(Number(pair.chainId))) {
      continue;
    }

    try {
      const result = await scanArbitragePair(pair);
      if (result) {
        opportunities.push(result);
      }
    } catch (error) {
      opportunities.push({
        type: "error",
        label: pair.label,
        chainId: pair.chainId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const position of config.liquidationPositions) {
    if (!chains.includes(Number(position.chainId))) {
      continue;
    }

    try {
      const result = await scanLiquidationPosition(position);
      if (result) {
        opportunities.push(result);
      }
    } catch (error) {
      opportunities.push({
        type: "error",
        label: position.label || position.borrower,
        chainId: position.chainId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return opportunities;
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  loadSearcherConfig,
  scanArbitragePair,
  scanLiquidationPosition,
  scanOpportunities,
};
