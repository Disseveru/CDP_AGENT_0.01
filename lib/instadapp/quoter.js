const { getProtocolAddresses, UNISWAP_QUOTER_ABI } = require("./protocols");
const { resolveRpcUrl } = require("./client");

/**
 * @param {import("web3").Web3} web3
 * @param {number} chainId
 * @param {{ tokenIn: string, tokenOut: string, amountInWei: string, fee?: number }} params
 */
async function quoteUniswapV3Single(web3, chainId, params) {
  const { uniswapV3QuoterV2 } = getProtocolAddresses(chainId);
  const fee = params.fee ?? 500;
  const quoter = new web3.eth.Contract(UNISWAP_QUOTER_ABI, uniswapV3QuoterV2);

  const result = await quoter.methods
    .quoteExactInputSingle({
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountInWei,
      fee,
      sqrtPriceLimitX96: 0,
    })
    .call();

  const amountOut = Array.isArray(result) ? result[0] : result.amountOut;
  return BigInt(amountOut);
}

/**
 * Computes Instadapp SWAP-AGGREGATOR-A unitAmt with 0.5% slippage buffer.
 *
 * @param {bigint} amountInWei
 * @param {bigint} amountOutWei
 */
function computeUnitAmt(amountInWei, amountOutWei) {
  if (amountInWei === 0n) {
    throw new Error("amountInWei must be greater than zero.");
  }

  const unit = (amountOutWei * 10n ** 18n) / amountInWei;
  const slippageBps = 50n;
  return ((unit * (10_000n - slippageBps)) / 10_000n).toString();
}

/**
 * @param {{ buyToken: string, sellToken: string, sellAmountWei: string, unitAmt: string, fee?: number }} params
 */
function buildSwapAggregatorSellSpell(params) {
  return {
    connector: "SWAP-AGGREGATOR-A",
    method: "sell",
    args: [
      params.buyToken,
      params.sellToken,
      params.fee ?? 500,
      params.unitAmt,
      params.sellAmountWei,
      0,
      0,
    ],
  };
}

/**
 * @param {number} chainId
 */
function createQuoterWeb3(chainId) {
  const Web3 = require("web3");
  return new Web3(new Web3.providers.HttpProvider(resolveRpcUrl(chainId)));
}

module.exports = {
  buildSwapAggregatorSellSpell,
  computeUnitAmt,
  createQuoterWeb3,
  quoteUniswapV3Single,
};
