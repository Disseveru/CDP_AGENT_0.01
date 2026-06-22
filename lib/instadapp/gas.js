const {
  createAvocadoWallet,
  ensureAvocadoGas,
  getAvocadoGasBalance,
  isAvocadoEnabled,
} = require("./avocadoWallet");

/**
 * Ensures gas is available for DSA operations.
 * With Avocado enabled (default), checks the USDC gas tank instead of native EOA balance.
 *
 * @param {string} _signerAddress
 * @param {number} _chainId
 * @param {"build" | "cast"} operation
 * @param {{ estimatedCostWei?: string, error?: string }} [_estimate]
 */
async function ensureDsaGas(_signerAddress, _chainId, operation, _estimate = {}) {
  if (!isAvocadoEnabled()) {
    const { ensureEoaGas } = require("../cdp/paymasterGas");
    const requiredWei =
      operation === "build" ? 2_000_000_000_000_000n : 1_000_000_000_000_000n;
    return ensureEoaGas(_signerAddress, _chainId, requiredWei);
  }

  const { safe } = createAvocadoWallet();
  const gasStatus = await ensureAvocadoGas(safe);

  return {
    funded: false,
    paymaster: false,
    avocado: true,
    operation,
    sufficient: gasStatus.sufficient,
    ...gasStatus,
  };
}

/**
 * @param {string} [_signerAddress]
 * @param {number} [_chainId]
 */
async function getDsaGasStatus(_signerAddress, _chainId) {
  if (!isAvocadoEnabled()) {
    const { getNativeBalanceWei } = require("../cdp/paymasterGas");
    const balanceWei = await getNativeBalanceWei(_signerAddress, _chainId);
    return {
      mode: "eoa",
      signerAddress: _signerAddress,
      chainId: _chainId,
      balanceWei: balanceWei.toString(),
    };
  }

  const { safe } = createAvocadoWallet();
  const gas = await getAvocadoGasBalance(safe);
  const { ownerAddress, safeAddress } = await require("./avocadoWallet").getAvocadoAddresses(safe);

  return {
    mode: "avocado",
    ownerAddress,
    safeAddress,
    chainId: _chainId,
    ...gas,
  };
}

module.exports = {
  ensureDsaGas,
  getDsaGasStatus,
};
