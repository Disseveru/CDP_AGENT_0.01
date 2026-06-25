const fs = require("fs");
const path = require("path");

const DSA = require("dsa-connect");
const Web3 = require("web3");

const {
  CHAIN_LABELS,
  DEFAULT_DSA_CHAIN_ID,
  DEFAULT_RPC_URLS,
  DSA_DATA_PATH,
  SUPPORTED_DSA_CHAIN_IDS,
} = require("./constants");
const { resolveSigningKey } = require("./keys");
const { buildSpellInstance, parseSpellsInput } = require("./spells");

/**
 * @returns {number}
 */
function resolveDsaChainId() {
  const raw = process.env.DSA_CHAIN_ID || String(DEFAULT_DSA_CHAIN_ID);
  const chainId = Number(raw);

  if (!Number.isInteger(chainId) || !SUPPORTED_DSA_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `Unsupported DSA_CHAIN_ID "${raw}". Instadapp supports: ${[...SUPPORTED_DSA_CHAIN_IDS].join(", ")}. Base Sepolia (84532) is not available in dsa-connect.`,
    );
  }

  return chainId;
}

/**
 * @param {number} chainId
 */
function resolveRpcUrl(chainId) {
  const { resolveChainRpcUrl } = require("../cdp/paymasterGas");
  const rpc = resolveChainRpcUrl(chainId);
  if (!rpc) {
    throw new Error(`No RPC URL for chain ${chainId}. Set DSA_RPC_URL or BASE_RPC_ENDPOINT.`);
  }

  return rpc;
}

/**
 * @param {string} [dataPath]
 * @returns {{ signerAddress?: string, chains?: Record<string, object> }}
 */
function loadDsaState(dataPath = path.join(process.cwd(), DSA_DATA_PATH)) {
  if (!fs.existsSync(dataPath)) {
    return { chains: {} };
  }

  const raw = fs.readFileSync(dataPath, "utf8").trim();
  if (!raw) {
    return { chains: {} };
  }

  const parsed = JSON.parse(raw);

  // Migrate legacy single-chain format.
  if (parsed.dsaId != null && parsed.chainId != null && !parsed.chains) {
    return {
      signerAddress: parsed.signerAddress,
      chains: {
        [String(parsed.chainId)]: {
          dsaId: parsed.dsaId,
          dsaAddress: parsed.dsaAddress,
          lastBuildTx: parsed.lastBuildTx,
        },
      },
    };
  }

  return {
    signerAddress: parsed.signerAddress,
    chains: parsed.chains || {},
  };
}

/**
 * @param {number} chainId
 * @param {string} [dataPath]
 */
function loadDsaChainState(chainId, dataPath = path.join(process.cwd(), DSA_DATA_PATH)) {
  const state = loadDsaState(dataPath);
  return state.chains?.[String(chainId)] || {};
}

/**
 * @param {object} state
 * @param {string} [dataPath]
 */
function saveDsaState(state, dataPath = path.join(process.cwd(), DSA_DATA_PATH)) {
  const normalized = {
    signerAddress: state.signerAddress,
    chains: state.chains || {},
  };

  fs.writeFileSync(dataPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * @param {number} chainId
 * @param {object} chainState
 * @param {string} signerAddress
 * @param {string} [dataPath]
 */
function saveDsaChainState(chainId, chainState, signerAddress, dataPath = path.join(process.cwd(), DSA_DATA_PATH)) {
  const state = loadDsaState(dataPath);
  saveDsaState(
    {
      signerAddress,
      chains: {
        ...state.chains,
        [String(chainId)]: chainState,
      },
    },
    dataPath,
  );
}

/**
 * Returns the persisted DSA id only when chain and signer metadata match.
 * DSA ids are scoped per chain; reusing a stale id after switching DSA_CHAIN_ID
 * would target a different smart account with the same numeric id.
 *
 * @param {object} state
 * @param {number} chainId
 * @param {string} signerAddress
 * @param {string} [authorityAddress]
 * @returns {number | undefined}
 */
function resolvePersistedDsaId(state, chainId, signerAddress, authorityAddress) {
  if (
    state.signerAddress &&
    state.signerAddress.toLowerCase() !== signerAddress.toLowerCase()
  ) {
    return undefined;
  }

  const chainState = state.chains?.[String(chainId)];
  if (chainState?.dsaId != null) {
    if (authorityAddress && chainState.authorityAddress) {
      if (chainState.authorityAddress.toLowerCase() !== authorityAddress.toLowerCase()) {
        return undefined;
      }
    } else if (
      authorityAddress &&
      !chainState.authorityAddress &&
      authorityAddress.toLowerCase() !== signerAddress.toLowerCase()
    ) {
      // State saved before authority metadata (e.g. REPL dsa build). Avocado safe
      // cannot be verified against a persisted id scoped to a different authority.
      return undefined;
    }

    return chainState.dsaId;
  }

  if (state.dsaId == null) {
    return undefined;
  }

  if (state.chainId == null || state.chainId !== chainId) {
    return undefined;
  }

  if (
    !state.signerAddress ||
    state.signerAddress.toLowerCase() !== signerAddress.toLowerCase()
  ) {
    return undefined;
  }

  return state.dsaId;
}

/**
 * Resolves the DSA authority for the current chain, preferring explicit overrides
 * and persisted state over auto-picking the highest-balance Avocado safe.
 *
 * @param {number} chainId
 * @param {{ authorityAddress?: string, privateKey?: string, dataPath?: string }} [options]
 */
async function resolveEffectiveAuthorityAddress(chainId, options = {}) {
  if (options.authorityAddress) {
    return options.authorityAddress;
  }

  const {
    isAvocadoEnabled,
    resolveDsaAuthorityAddress,
    resolveExplicitAvocadoSafeAddress,
  } = require("./avocadoWallet");

  if (!isAvocadoEnabled()) {
    return resolveDsaAuthorityAddress(options.privateKey);
  }

  const explicitSafe = resolveExplicitAvocadoSafeAddress();
  if (explicitSafe) {
    return explicitSafe;
  }

  const chainState = loadDsaChainState(chainId, options.dataPath);
  if (chainState.authorityAddress) {
    return chainState.authorityAddress;
  }

  return resolveDsaAuthorityAddress(options.privateKey);
}

/**
 * @param {{ chainId?: number, privateKey?: string, rpcUrl?: string }} [options]
 */
function createDsaClient(options = {}) {
  const chainId = options.chainId ?? resolveDsaChainId();
  const privateKey = options.privateKey ?? resolveSigningKey();
  const rpcUrl = options.rpcUrl ?? resolveRpcUrl(chainId);
  const web3 = new Web3(new Web3.providers.HttpProvider(rpcUrl));
  const dsa = new DSA({ web3, mode: "node", privateKey }, chainId);
  const signerAddress = web3.eth.accounts.privateKeyToAccount(privateKey).address;

  return { dsa, web3, chainId, signerAddress, privateKey };
}

/**
 * @param {import("dsa-connect").DSA} dsa
 * @param {string} signerAddress
 */
async function listDsaAccounts(dsa, signerAddress) {
  return dsa.getAccounts(signerAddress);
}

/**
 * @param {import("dsa-connect").DSA} dsa
 * @param {import("web3").Web3} web3
 * @param {{ gasPriceGwei?: string }} [options]
 */
async function buildDsaAccount(dsa, web3, options = {}) {
  const { ensureDsaGas } = require("./gas");
  const {
    buildDsaAccountViaAvocado,
    createAvocadoWallet,
    isAvocadoEnabled,
  } = require("./avocadoWallet");
  const chainId = options.chainId ?? resolveDsaChainId();
  const ownerAddress =
    options.signerAddress ||
    web3.eth.accounts.privateKeyToAccount(resolveSigningKey()).address;
  const authorityAddress = await resolveEffectiveAuthorityAddress(chainId, options);
  const gasFunding = await ensureDsaGas(ownerAddress, chainId, "build", {}, { authorityAddress });

  if (isAvocadoEnabled()) {
    const safeAddress = authorityAddress;
    const { safe } = createAvocadoWallet(options.privateKey, safeAddress);
    const avocadoBuild = await buildDsaAccountViaAvocado(dsa, web3, safe, safeAddress, chainId, {
      ownerAddress,
    });
    return {
      txHash: avocadoBuild.txHash,
      gasFunding,
      authorityAddress,
      ownerAddress,
      ...avocadoBuild,
    };
  }

  const gasPriceGwei =
    options.gasPriceGwei ||
    process.env.DSA_GAS_PRICE_GWEI ||
    (await web3.eth.getGasPrice());

  const txHash = await dsa.build({
    version: 2,
    gasPrice: gasPriceGwei,
  });

  return { txHash, gasFunding, authorityAddress, ownerAddress };
}

/**
 * @param {import("dsa-connect").DSA} dsa
 * @param {string} signerAddress
 * @param {{ dsaId?: number, autoBuild?: boolean, gasPriceGwei?: string }} [options]
 * @param {import("web3").Web3} web3
 */
async function ensureDsaInstance(dsa, web3, signerAddress, options = {}) {
  const chainId = options.chainId ?? resolveDsaChainId();
  const ownerAddress = signerAddress;
  const state = loadDsaState();
  const chainState = loadDsaChainState(chainId);
  const authorityAddress = await resolveEffectiveAuthorityAddress(chainId, options);
  const requestedId =
    options.dsaId ?? resolvePersistedDsaId(state, chainId, ownerAddress, authorityAddress);
  const accounts = await listDsaAccounts(dsa, authorityAddress);

  if (requestedId != null) {
    const match = accounts.find((account) => account.id === requestedId);
    if (!match) {
      throw new Error(
        `DSA id ${requestedId} was not found for authority ${authorityAddress}.`,
      );
    }

    const instance = await dsa.setInstance(requestedId);
    saveDsaChainState(
      chainId,
      {
        dsaId: instance.id,
        dsaAddress: instance.address,
        lastBuildTx: chainState.lastBuildTx,
        authorityAddress,
      },
      ownerAddress,
    );

    return { instance, accounts, created: false, authorityAddress, ownerAddress };
  }

  if (accounts.length > 0) {
    const instance = await dsa.setInstance(accounts[0].id);
    saveDsaChainState(
      chainId,
      {
        dsaId: instance.id,
        dsaAddress: instance.address,
        lastBuildTx: chainState.lastBuildTx,
        authorityAddress,
      },
      ownerAddress,
    );

    return { instance, accounts, created: false, authorityAddress, ownerAddress };
  }

  if (options.autoBuild === false) {
    throw new Error(
      `No DSA accounts found for Avocado authority ${authorityAddress}. Run "dsa build" or pass --build to create one.`,
    );
  }

  const buildResult = await buildDsaAccount(dsa, web3, {
    ...options,
    chainId,
    signerAddress: ownerAddress,
    authorityAddress,
  });
  const txHash = buildResult.txHash;
  const refreshed = await listDsaAccounts(dsa, authorityAddress);
  if (refreshed.length === 0) {
    throw new Error(`DSA build transaction ${txHash} was sent, but no account is visible yet.`);
  }

  const instance = await dsa.setInstance(refreshed[0].id);
  saveDsaChainState(
    chainId,
    {
      dsaId: instance.id,
      dsaAddress: instance.address,
      lastBuildTx: txHash,
      authorityAddress,
    },
    ownerAddress,
  );

  return {
    instance,
    accounts: refreshed,
    created: true,
    buildTxHash: txHash,
    gasFunding: buildResult.gasFunding,
    authorityAddress,
    ownerAddress,
  };
}

/**
 * @param {import("dsa-connect").DSA} dsa
 * @param {import("web3").Web3} web3
 * @param {unknown} spellsInput
 * @param {{ valueWei?: string, gasPriceGwei?: string, dryRun?: boolean }} [options]
 */
async function castSpells(dsa, web3, spellsInput, options = {}) {
  const { ensureDsaGas } = require("./gas");
  const { castSpellsViaAvocado, createAvocadoWallet, isAvocadoEnabled } = require("./avocadoWallet");
  const chainId = options.chainId ?? resolveDsaChainId();
  const ownerAddress =
    options.signerAddress ||
    web3.eth.accounts.privateKeyToAccount(resolveSigningKey()).address;

  if (isAvocadoEnabled()) {
    const { resolveAvocadoSafeAddress } = require("./avocadoWallet");
    const safeAddress =
      options.authorityAddress ||
      options.safeAddress ||
      (await resolveAvocadoSafeAddress(options.privateKey));
    const { safe } = createAvocadoWallet(options.privateKey, safeAddress);
    return castSpellsViaAvocado(dsa, safe, safeAddress, spellsInput, chainId, {
      dryRun: options.dryRun,
      flashLoan: options.flashLoan,
    });
  }

  const spells = parseSpellsInput(spellsInput);
  const spellInstance = buildSpellInstance(dsa, spells);
  const gasPriceGwei =
    options.gasPriceGwei ||
    process.env.DSA_GAS_PRICE_GWEI ||
    (await web3.eth.getGasPrice());

  const castParams = {
    gasPrice: gasPriceGwei,
  };

  if (options.valueWei) {
    castParams.value = options.valueWei;
  }

  if (options.dryRun) {
    const encoded = await spellInstance.encodeSpells();
    let gas;
    try {
      gas = await spellInstance.estimateCastGas();
    } catch (error) {
      gas = { error: error instanceof Error ? error.message : String(error) };
    }

    return {
      dryRun: true,
      spells,
      encoded,
      estimatedGas: gas,
      castParams,
    };
  }

  let gasFunding;
  try {
    const estimatedGas = await spellInstance.estimateCastGas();
    const gasLimit = BigInt(
      typeof estimatedGas === "object" && estimatedGas != null && estimatedGas.gas
        ? estimatedGas.gas
        : estimatedGas || 0,
    );
    const estimatedCostWei = gasLimit * BigInt(gasPriceGwei);
    gasFunding = await ensureDsaGas(ownerAddress, chainId, "cast", {
      costWei: estimatedCostWei.toString(),
    });
  } catch {
    gasFunding = await ensureDsaGas(ownerAddress, chainId, "cast");
  }

  const txHash = await spellInstance.cast(castParams);
  return {
    dryRun: false,
    spells,
    txHash,
    castParams,
    gasFunding,
  };
}

/**
 * @param {import("dsa-connect").DSA} dsa
 * @param {import("web3").Web3} web3
 */
async function estimateDsaBuildCost(dsa, web3, options = {}) {
  const gasPrice = await web3.eth.getGasPrice();
  const from =
    options.signerAddress ||
    web3.eth.accounts.privateKeyToAccount(resolveSigningKey()).address;
  try {
    const buildParams = { from, gasPrice, version: 2 };
    if (options.authorityAddress) {
      buildParams.authority = options.authorityAddress;
    }
    const tx = await dsa.buildTransactionConfig(buildParams);
    const gas = BigInt(tx.gas || tx.gasLimit || 0);
    const cost = gas * BigInt(gasPrice);
    return {
      gasPrice: String(gasPrice),
      gas: String(gas),
      costWei: cost.toString(),
      costEth: web3.utils.fromWei(cost.toString(), "ether"),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message, gasPrice: String(gasPrice) };
  }
}

/** Default chains for multi-chain DSA setup: Base, Arbitrum, Polygon. */
const DEFAULT_DSA_BUILD_CHAINS = [8453, 42161, 137];

/**
 * @param {number[]} [chainIds]
 * @param {{ force?: boolean }} [options]
 */
async function buildDsaAccountsForChains(chainIds = DEFAULT_DSA_BUILD_CHAINS, options = {}) {
  const { ensureDsaGas } = require("./gas");
  const { isAvocadoEnabled } = require("./avocadoWallet");
  const { signerAddress, privateKey } = createDsaClient({ chainId: chainIds[0] });
  const summary = [];

  for (const chainId of chainIds) {
    const authorityAddress = await resolveEffectiveAuthorityAddress(chainId, { privateKey });
    const { dsa, web3 } = createDsaClient({ chainId, privateKey });
    const label = formatChainLabel(chainId);
    const accounts = await listDsaAccounts(dsa, authorityAddress);
    const estimate = await estimateDsaBuildCost(dsa, web3, { authorityAddress, signerAddress });

    if (accounts.length > 0 && !options.force) {
      const instance = await dsa.setInstance(accounts[0].id);
      saveDsaChainState(
        chainId,
        {
          dsaId: instance.id,
          dsaAddress: instance.address,
          authorityAddress,
        },
        signerAddress,
      );
      summary.push({
        chainId,
        chain: label,
        status: "exists",
        dsaId: instance.id,
        dsaAddress: instance.address,
        ownerAddress: signerAddress,
        authorityAddress,
      });
      continue;
    }

    let gasStatus;
    try {
      gasStatus = await ensureDsaGas(signerAddress, chainId, "build", estimate, { authorityAddress });
    } catch (error) {
      summary.push({
        chainId,
        chain: label,
        status: "needs_gas",
        ownerAddress: signerAddress,
        authorityAddress,
        estimate,
        gasError: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (estimate.error && !isAvocadoEnabled()) {
      summary.push({
        chainId,
        chain: label,
        status: "error",
        ownerAddress: signerAddress,
        authorityAddress,
        estimate,
        error: estimate.error,
      });
      continue;
    }

    try {
      const buildResult = await buildDsaAccount(dsa, web3, {
        chainId,
        signerAddress,
        authorityAddress,
        privateKey,
      });
      const txHash = buildResult.txHash;
      const refreshed = await listDsaAccounts(dsa, authorityAddress);
      if (refreshed.length === 0) {
        summary.push({
          chainId,
          chain: label,
          status: "error",
          ownerAddress: signerAddress,
          authorityAddress,
          error: `DSA build transaction ${txHash} was sent, but no account is visible yet.`,
        });
        continue;
      }

      const instance = await dsa.setInstance(refreshed[0].id);
      saveDsaChainState(
        chainId,
        {
          dsaId: instance.id,
          dsaAddress: instance.address,
          lastBuildTx: txHash,
          authorityAddress,
        },
        signerAddress,
      );
      summary.push({
        chainId,
        chain: label,
        status: "created",
        txHash,
        dsaId: instance.id,
        dsaAddress: instance.address,
        ownerAddress: signerAddress,
        authorityAddress,
        gasStatus,
      });
    } catch (error) {
      summary.push({
        chainId,
        chain: label,
        status: "error",
        ownerAddress: signerAddress,
        authorityAddress,
        estimate,
        gasStatus,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const primaryAuthorityAddress = await resolveEffectiveAuthorityAddress(chainIds[0], {
    privateKey,
  });

  return {
    ownerAddress: signerAddress,
    authorityAddress: primaryAuthorityAddress,
    chains: summary,
    persisted: loadDsaState(),
  };
}

/**
 * @param {number} chainId
 */
function formatChainLabel(chainId) {
  return CHAIN_LABELS[chainId] || `chain-${chainId}`;
}

module.exports = {
  buildDsaAccount,
  buildDsaAccountsForChains,
  castSpells,
  createDsaClient,
  DEFAULT_DSA_BUILD_CHAINS,
  ensureDsaInstance,
  estimateDsaBuildCost,
  formatChainLabel,
  listDsaAccounts,
  loadDsaChainState,
  loadDsaState,
  resolveDsaChainId,
  resolveEffectiveAuthorityAddress,
  resolvePersistedDsaId,
  resolveRpcUrl,
  saveDsaChainState,
  saveDsaState,
};
