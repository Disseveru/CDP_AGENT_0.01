const { Wallet, ethers } = require("ethers");
const { StaticJsonRpcProvider } = require("@ethersproject/providers");
const {
  createSafe,
  AVOCADO_RPC,
  setRpcUrls,
} = require("@instadapp/avocado");

const { resolveSigningKey } = require("./keys");
const { DEFAULT_RPC_URLS } = require("./constants");
const { buildSpellInstance, parseSpellsInput } = require("./spells");

const AVOCADO_CHAIN_ID = 634;
/** Avocado `api_getBalance` returns USDC gas scaled to 18 decimals. */
const GAS_BALANCE_DECIMALS = 18;

/** Minimum USDC gas tank balance (18-decimal units) before casting. */
const DEFAULT_MIN_GAS_USDC = 10n ** 18n; // 1 USDC

/**
 * @param {string} method
 * @param {unknown[]} params
 */
async function avocadoRpc(method, params = []) {
  const response = await fetch(AVOCADO_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  const payload = await response.json();
  if (payload.error) {
    throw new Error(
      `Avocado RPC ${method} failed: ${payload.error.message || JSON.stringify(payload.error)}`,
    );
  }

  return payload.result;
}

/**
 * @param {string | undefined | null} raw
 * @returns {bigint}
 */
function parseApiBalance(raw) {
  if (!raw || raw === "0x0" || raw === "0") {
    return 0n;
  }

  const negative = String(raw).startsWith("-");
  const hex = String(raw).replace(/^-/, "");
  let value = BigInt(hex);
  if (negative) {
    value = -value;
  }

  return value;
}

/**
 * @param {bigint} balance
 */
function formatGasBalance(balance) {
  return ethers.utils.formatUnits(balance < 0n ? 0n : balance, GAS_BALANCE_DECIMALS);
}

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

function createAvocadoProvider() {
  return new StaticJsonRpcProvider(AVOCADO_RPC, {
    chainId: AVOCADO_CHAIN_ID,
    name: "avocado",
  });
}

function isAvocadoEnabled() {
  if (process.env.DSA_USE_AVOCADO === "0" || process.env.DSA_USE_AVOCADO === "false") {
    return false;
  }

  return true;
}

/**
 * @param {string} [ownerAddress]
 */
async function listAvocadoSafes(ownerAddress) {
  const owner = ownerAddress || new Wallet(resolveSigningKey()).address;
  const result = await avocadoRpc("api_getSafes", [{ address: owner }]);
  const rows = Array.isArray(result?.data) ? result.data : [];

  return rows.map((row) => ({
    safeAddress: row.safe_address,
    ownerAddress: row.owner_address,
    multisig: Boolean(row.multisig),
    multisigIndex: row.multisig_index,
    deployed: row.deployed || {},
    version: row.version || {},
  }));
}

/**
 * @param {string} ownerAddress
 * @param {Awaited<ReturnType<typeof listAvocadoSafes>>} safes
 */
async function pickAvocadoSafeAddress(ownerAddress, safes) {
  const explicit =
    process.env.AVOCADO_SAFE_ADDRESS ||
    process.env.DSA_AVOCADO_SAFE ||
    process.env.DSA_AVOCADO_SAFE_ADDRESS;

  if (explicit) {
    return explicit;
  }

  let bestAddress;
  let bestBalance = 0n;

  for (const safe of safes) {
    const settled = parseApiBalance(await avocadoRpc("api_getBalance", [safe.safeAddress]));
    const pending = parseApiBalance(
      await avocadoRpc("api_getBalance", [safe.safeAddress, "pending"]),
    );
    const balance = pending > settled ? pending : settled;

    if (balance > bestBalance) {
      bestBalance = balance;
      bestAddress = safe.safeAddress;
    }
  }

  if (bestAddress && bestBalance > 0n) {
    return bestAddress;
  }

  configureAvocadoRpc();
  const provider = createAvocadoProvider();
  const wallet = new Wallet(resolveSigningKey(), provider);
  const safe = createSafe(wallet);
  return safe.getSafeAddress();
}

/**
 * @param {string} [privateKey]
 */
async function resolveAvocadoSafeAddress(privateKey = resolveSigningKey()) {
  const ownerAddress = new Wallet(privateKey).address;
  const safes = await listAvocadoSafes(ownerAddress);
  return pickAvocadoSafeAddress(ownerAddress, safes);
}

/**
 * @param {string} [privateKey]
 * @param {string} [safeAddress]
 */
function createAvocadoWallet(privateKey = resolveSigningKey(), safeAddress) {
  configureAvocadoRpc();
  const provider = createAvocadoProvider();
  const wallet = new Wallet(privateKey, provider);
  const safe = createSafe(wallet);

  return {
    safe,
    wallet,
    provider,
    safeAddress,
    ownerAddress: wallet.address,
  };
}

/**
 * @param {{ safeAddress?: string, ownerAddress?: string }} context
 */
async function getAvocadoAddresses(context = {}) {
  const ownerAddress = context.ownerAddress || new Wallet(resolveSigningKey()).address;
  const safeAddress = context.safeAddress || (await resolveAvocadoSafeAddress());

  return { ownerAddress, safeAddress };
}

/**
 * Returns the Avocado USDC gas tank balance via `api_getBalance`.
 *
 * @param {string} safeAddress
 */
async function getAvocadoGasBalanceForAddress(safeAddress) {
  const settled = parseApiBalance(await avocadoRpc("api_getBalance", [safeAddress]));
  const pending = parseApiBalance(
    await avocadoRpc("api_getBalance", [safeAddress, "pending"]),
  );
  const balanceUsdc = pending > settled ? pending : settled;

  return {
    safeAddress,
    balanceUsdc: balanceUsdc.toString(),
    balanceHuman: formatGasBalance(balanceUsdc),
    settledUsdc: settled.toString(),
    pendingUsdc: pending.toString(),
    settledHuman: formatGasBalance(settled),
    pendingHuman: formatGasBalance(pending),
  };
}

/**
 * @param {{ safeAddress?: string }} [context]
 */
async function getAvocadoGasBalance(context = {}) {
  const { safeAddress } = await getAvocadoAddresses(context);
  return getAvocadoGasBalanceForAddress(safeAddress);
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
 * @param {string} safeAddress
 * @param {bigint} [minimumUsdc]
 */
async function ensureAvocadoGasForAddress(safeAddress, minimumUsdc = DEFAULT_MIN_GAS_USDC) {
  const gas = await getAvocadoGasBalanceForAddress(safeAddress);

  if (BigInt(gas.balanceUsdc) >= minimumUsdc) {
    return {
      sufficient: true,
      ...gas,
      minimumUsdc: minimumUsdc.toString(),
    };
  }

  throw new Error(
    `Avocado gas tank for ${gas.safeAddress} has ${gas.balanceHuman} USDC but at least ` +
      `${formatGasBalance(minimumUsdc)} USDC is required. ` +
      "Top up USDC gas in the Avocado wallet app or set AVOCADO_SAFE_ADDRESS to a funded safe.",
  );
}

/**
 * @param {ReturnType<typeof createSafe>} safe
 * @param {string} safeAddress
 * @param {bigint} [minimumUsdc]
 */
async function ensureAvocadoGas(safe, safeAddress, minimumUsdc = DEFAULT_MIN_GAS_USDC) {
  return ensureAvocadoGasForAddress(safeAddress, minimumUsdc);
}

/**
 * @param {import("dsa-connect").DSA} dsa
 * @param {ReturnType<typeof createSafe>} safe
 * @param {string} safeAddress
 * @param {unknown} spellsInput
 * @param {number} chainId
 * @param {{ dryRun?: boolean, flashLoan?: boolean }} [options]
 */
async function castSpellsViaAvocado(dsa, safe, safeAddress, spellsInput, chainId, options = {}) {
  const spells = parseSpellsInput(spellsInput);
  const spellInstance = buildSpellInstance(dsa, spells);
  const actions = await dsa.convertToAvocadoActions(spellInstance, 2, chainId);
  const transactions = toAvocadoTransactions(actions);
  const signatureOptions = {
    safeAddress,
    id: options.flashLoan ? "20" : "0",
  };

  if (options.dryRun) {
    let estimatedFee;
    try {
      estimatedFee = await safe.estimateFee(transactions, chainId, signatureOptions);
    } catch (error) {
      estimatedFee = {
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      dryRun: true,
      broadcaster: "avocado",
      safeAddress,
      spells,
      actions,
      transactions,
      estimatedFee,
    };
  }

  const gasStatus = await ensureAvocadoGas(safe, safeAddress);
  const response = await safe.sendTransactions(transactions, chainId, signatureOptions);

  return {
    dryRun: false,
    broadcaster: "avocado",
    safeAddress,
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
 * @param {string} safeAddress
 * @param {number} chainId
 */
async function buildDsaAccountViaAvocado(dsa, web3, safe, safeAddress, chainId, options = {}) {
  const gasPrice = await web3.eth.getGasPrice();
  const ownerAddress =
    options.ownerAddress || new Wallet(resolveSigningKey()).address;

  let buildTx;
  try {
    // dsa.build() defaults authority to the EOA and broadcasts from it. Avocado must
    // relay a build tx that registers the safe as DSA authority (see dsa-connect build()).
    buildTx = await dsa.buildTransactionConfig({
      from: ownerAddress,
      authority: safeAddress,
      version: 2,
      gasPrice,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not encode DSA build transaction for Avocado safe ${safeAddress}: ${message}`,
    );
  }

  const gasStatus = await ensureAvocadoGas(safe, safeAddress);
  const response = await safe.sendTransactions(
    [
      {
        to: buildTx.to,
        data: buildTx.data,
        value: buildTx.value || 0,
      },
    ],
    chainId,
    { safeAddress },
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

  return resolveAvocadoSafeAddress(privateKey);
}

/**
 * @param {string} [ownerAddress]
 */
async function getAvocadoGasOverview(ownerAddress) {
  const owner = ownerAddress || new Wallet(resolveSigningKey()).address;
  const safes = await listAvocadoSafes(owner);
  const selectedSafeAddress = await pickAvocadoSafeAddress(owner, safes);
  const balances = [];

  for (const safe of safes) {
    balances.push({
      ...safe,
      ...(await getAvocadoGasBalanceForAddress(safe.safeAddress)),
      selected: safe.safeAddress.toLowerCase() === selectedSafeAddress.toLowerCase(),
    });
  }

  const selected = balances.find((entry) => entry.selected) || balances[0];

  return {
    ownerAddress: owner,
    selectedSafeAddress,
    safes: balances,
    ...selected,
  };
}

module.exports = {
  AVOCADO_CHAIN_ID,
  DEFAULT_MIN_GAS_USDC,
  GAS_BALANCE_DECIMALS,
  buildDsaAccountViaAvocado,
  castSpellsViaAvocado,
  configureAvocadoRpc,
  createAvocadoProvider,
  createAvocadoWallet,
  ensureAvocadoGas,
  ensureAvocadoGasForAddress,
  formatGasBalance,
  getAvocadoAddresses,
  getAvocadoGasBalance,
  getAvocadoGasBalanceForAddress,
  getAvocadoGasOverview,
  isAvocadoEnabled,
  listAvocadoSafes,
  parseApiBalance,
  pickAvocadoSafeAddress,
  resolveAvocadoSafeAddress,
  resolveDsaAuthorityAddress,
  toAvocadoTransactions,
};
