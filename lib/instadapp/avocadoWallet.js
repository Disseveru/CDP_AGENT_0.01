const { Wallet, ethers } = require("ethers");
const {
  createSafe,
  AVOCADO_RPC,
  setRpcUrls,
} = require("@instadapp/avocado");

const { resolveSigningKey } = require("./keys");
const { DEFAULT_RPC_URLS } = require("./constants");
const { buildSpellInstance, parseSpellsInput } = require("./spells");

const AVOCADO_CHAIN_ID = 634;
const USDC_GAS_DECIMALS = 6;

/** Minimum USDC gas tank balance (6 decimals) before casting. */
const DEFAULT_MIN_GAS_USDC = 1_000_000n; // 1 USDC

/**
 * @param {Record<number, string>} [overrides]
 */
function configureAvocadoRpc(overrides = {}) {
  const rpcUrls = { ...DEFAULT_RPC_URLS, ...overrides };

  for (const [chainId, url] of Object.entries(process.env)) {
    if (chainId.startsWith("DSA_RPC_URL_")) {
      const id = Number(chainId.replace("DSA_RPC_URL_", ""));
      if (!Number.isNaN(id) && url) {
        rpcUrls[id] = url;
      }
    }
  }

  if (process.env.DSA_RPC_URL) {
    const chainId = Number(process.env.DSA_CHAIN_ID || 8453);
    rpcUrls[chainId] = process.env.DSA_RPC_URL;
  }

  setRpcUrls(rpcUrls);
}

function isAvocadoEnabled() {
  if (process.env.DSA_USE_AVOCADO === "0" || process.env.DSA_USE_AVOCADO === "false") {
    return false;
  }

  return true;
}

/**
 * @param {string} [privateKey]
 */
function createAvocadoWallet(privateKey = resolveSigningKey()) {
  configureAvocadoRpc();
  const provider = new ethers.providers.JsonRpcProvider(AVOCADO_RPC);
  const wallet = new Wallet(privateKey, provider);
  const safe = createSafe(wallet);

  return { safe, wallet, provider };
}

/**
 * @param {ReturnType<typeof createSafe>} safe
 */
async function getAvocadoAddresses(safe) {
  const ownerAddress = await safe.getOwnerAddress();
  const safeAddress = await safe.getSafeAddress();

  return { ownerAddress, safeAddress };
}

/**
 * Returns the Avocado USDC gas tank balance (provider balance on chain 634).
 *
 * @param {ReturnType<typeof createSafe>} safe
 */
async function getAvocadoGasBalance(safe) {
  const { safeAddress } = await getAvocadoAddresses(safe);
  const balance = await safe.getSigner().provider.getBalance(safeAddress);
  return {
    safeAddress,
    balanceUsdc: balance.toString(),
    balanceHuman: ethers.utils.formatUnits(balance, USDC_GAS_DECIMALS),
  };
}

/**
 * @param {import("dsa-connect/dist/resolvers/avocado").AvocadoAction[]} actions
 */
function toAvocadoTransactions(actions) {
  return actions.map((action) => ({
    to: action.target,
    data: action.data,
    value: action.value ?? 0,
    operation: action.operation ?? 0,
  }));
}

/**
 * @param {ReturnType<typeof createSafe>} safe
 * @param {bigint} [minimumUsdc]
 */
async function ensureAvocadoGas(safe, minimumUsdc = DEFAULT_MIN_GAS_USDC) {
  const gas = await getAvocadoGasBalance(safe);

  if (BigInt(gas.balanceUsdc) >= minimumUsdc) {
    return {
      sufficient: true,
      ...gas,
      minimumUsdc: minimumUsdc.toString(),
    };
  }

  throw new Error(
    `Avocado gas tank for ${gas.safeAddress} has ${gas.balanceHuman} USDC but at least ` +
      `${ethers.utils.formatUnits(minimumUsdc, USDC_GAS_DECIMALS)} USDC is required. ` +
      "Top up USDC gas in the Avocado wallet app or send USDC to the safe and deposit into the gas tank.",
  );
}

/**
 * @param {import("dsa-connect").DSA} dsa
 * @param {ReturnType<typeof createSafe>} safe
 * @param {unknown} spellsInput
 * @param {number} chainId
 * @param {{ dryRun?: boolean, flashLoan?: boolean }} [options]
 */
async function castSpellsViaAvocado(dsa, safe, spellsInput, chainId, options = {}) {
  const spells = parseSpellsInput(spellsInput);
  const spellInstance = buildSpellInstance(dsa, spells);
  const actions = await dsa.convertToAvocadoActions(spellInstance, 2, chainId);
  const transactions = toAvocadoTransactions(actions);

  if (options.dryRun) {
    let estimatedFee;
    try {
      estimatedFee = await safe.estimateFee(transactions, chainId, {
        id: options.flashLoan ? "20" : "0",
      });
    } catch (error) {
      estimatedFee = {
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      dryRun: true,
      broadcaster: "avocado",
      spells,
      actions,
      transactions,
      estimatedFee,
    };
  }

  const gasStatus = await ensureAvocadoGas(safe);
  const response = await safe.sendTransactions(transactions, chainId, {
    id: options.flashLoan ? "20" : "0",
  });

  return {
    dryRun: false,
    broadcaster: "avocado",
    spells,
    actions,
    txHash: response.hash,
    gasStatus,
  };
}

/**
 * Creates a DSA account with the Avocado safe as authority, paid from the USDC gas tank.
 *
 * @param {import("dsa-connect").DSA} dsa
 * @param {import("web3").Web3} web3
 * @param {ReturnType<typeof createSafe>} safe
 * @param {number} chainId
 */
async function buildDsaAccountViaAvocado(dsa, web3, safe, chainId) {
  const gasPrice = await web3.eth.getGasPrice();
  const { safeAddress } = await getAvocadoAddresses(safe);

  let buildTx;
  try {
    buildTx = await dsa.build({ version: 2, gasPrice, return: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not encode DSA build transaction for Avocado safe ${safeAddress}: ${message}`,
    );
  }

  const gasStatus = await ensureAvocadoGas(safe);
  const response = await safe.sendTransactions(
    [
      {
        to: buildTx.to,
        data: buildTx.data,
        value: buildTx.value || 0,
      },
    ],
    chainId,
  );

  return {
    broadcaster: "avocado",
    txHash: response.hash,
    safeAddress,
    gasStatus,
  };
}

/**
 * Resolves which address owns DSA accounts when using Avocado.
 *
 * @param {string} [privateKey]
 */
async function resolveDsaAuthorityAddress(privateKey = resolveSigningKey()) {
  if (!isAvocadoEnabled()) {
    const Web3 = require("web3");
    return new Web3().eth.accounts.privateKeyToAccount(privateKey).address;
  }

  const { safe } = createAvocadoWallet(privateKey);
  const { safeAddress } = await getAvocadoAddresses(safe);
  return safeAddress;
}

module.exports = {
  AVOCADO_CHAIN_ID,
  DEFAULT_MIN_GAS_USDC,
  buildDsaAccountViaAvocado,
  castSpellsViaAvocado,
  configureAvocadoRpc,
  createAvocadoWallet,
  ensureAvocadoGas,
  getAvocadoAddresses,
  getAvocadoGasBalance,
  isAvocadoEnabled,
  resolveDsaAuthorityAddress,
  toAvocadoTransactions,
};
