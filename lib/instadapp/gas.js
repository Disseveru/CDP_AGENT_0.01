const { ensureEoaGas, getNativeBalanceWei } = require("../cdp/paymasterGas");

/** Default gas buffer for DSA build (~0.002 ETH). */
const DEFAULT_BUILD_GAS_WEI = 2_000_000_000_000_000n;

/** Default gas buffer for DSA cast (~0.001 ETH). */
const DEFAULT_CAST_GAS_WEI = 1_000_000_000_000_000n;

/**
 * @param {bigint | string} estimateWei
 */
function parseEstimateWei(estimateWei) {
  if (estimateWei == null) {
    return 0n;
  }

  return BigInt(estimateWei);
}

/**
 * Ensures the DSA EOA signer can pay native gas, using CDP paymaster when needed.
 *
 * @param {string} signerAddress
 * @param {number} chainId
 * @param {"build" | "cast"} operation
 * @param {{ estimatedCostWei?: string, error?: string }} [estimate]
 */
async function ensureDsaGas(signerAddress, chainId, operation, estimate = {}) {
  const fallback = operation === "build" ? DEFAULT_BUILD_GAS_WEI : DEFAULT_CAST_GAS_WEI;
  const estimated = parseEstimateWei(estimate.costWei);
  const requiredWei =
    estimated > 0n
      ? estimated + estimated / 5n
      : estimate.error?.match(/want (\d+)/)
        ? BigInt(estimate.error.match(/want (\d+)/)[1])
        : fallback;

  const result = await ensureEoaGas(signerAddress, chainId, requiredWei);
  const balanceWei = await getNativeBalanceWei(signerAddress, chainId);

  if (!result.sufficient && balanceWei < requiredWei) {
    throw new Error(
      `DSA signer ${signerAddress} still lacks gas on chain ${chainId}. ` +
        `Need ~${requiredWei} wei, have ${balanceWei} wei. ` +
        "Fund the EOA or ensure CDP paymaster credentials are valid.",
    );
  }

  return {
    ...result,
    operation,
    requiredWei: requiredWei.toString(),
  };
}

module.exports = {
  DEFAULT_BUILD_GAS_WEI,
  DEFAULT_CAST_GAS_WEI,
  ensureDsaGas,
};
