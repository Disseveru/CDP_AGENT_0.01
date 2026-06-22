const {
  ensureAvocadoGasForAddress,
  getAvocadoGasOverview,
  isAvocadoEnabled,
  resolveAvocadoSafeAddress,
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

  const safeAddress = await resolveAvocadoSafeAddress();
  const gasStatus = await ensureAvocadoGasForAddress(safeAddress);

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
 * @param {string} [signerAddress]
 * @param {number} [_chainId]
 */
async function getDsaGasStatus(signerAddress, _chainId) {
  if (!isAvocadoEnabled()) {
    const { getNativeBalanceWei } = require("../cdp/paymasterGas");
    const balanceWei = await getNativeBalanceWei(signerAddress, _chainId);
    return {
      mode: "eoa",
      signerAddress,
      chainId: _chainId,
      balanceWei: balanceWei.toString(),
    };
  }

  const overview = await getAvocadoGasOverview(signerAddress);

  return {
    mode: "avocado",
    chainId: _chainId,
    ownerAddress: overview.ownerAddress,
    safeAddress: overview.selectedSafeAddress,
    balanceUsdc: overview.balanceUsdc,
    balanceHuman: overview.balanceHuman,
    settledHuman: overview.settledHuman,
    pendingHuman: overview.pendingHuman,
    safes: overview.safes.map((safe) => ({
      safeAddress: safe.safeAddress,
      multisig: safe.multisig,
      multisigIndex: safe.multisigIndex,
      balanceHuman: safe.balanceHuman,
      selected: safe.selected,
      deployedOnBase: Boolean(safe.deployed?.["8453"]),
    })),
  };
}

module.exports = {
  ensureDsaGas,
  getDsaGasStatus,
};
