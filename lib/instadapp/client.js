const fs = require("fs");
const path = require("path");

const DSA = require("dsa-connect");
const Web3 = require("web3");
const { toHex } = require("viem");
const { mnemonicToAccount } = require("viem/accounts");

const {
  CHAIN_LABELS,
  DEFAULT_DSA_CHAIN_ID,
  DEFAULT_RPC_URLS,
  DSA_DATA_PATH,
  SUPPORTED_DSA_CHAIN_IDS,
} = require("./constants");
const { ensureDsaGas } = require("./gas");
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
  if (process.env.DSA_RPC_URL) {
    return process.env.DSA_RPC_URL;
  }

  const rpc = DEFAULT_RPC_URLS[chainId];
  if (!rpc) {
    throw new Error(`No default RPC URL for chain ${chainId}. Set DSA_RPC_URL.`);
  }

  return rpc;
}

/**
 * @param {string} privateKey
 */
function normalizePrivateKey(privateKey) {
  const trimmed = privateKey.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

/**
 * @param {string} value
 */
function looksLikeMnemonic(value) {
  const words = value.trim().split(/\s+/);
  return words.length >= 12 && words.every((word) => /^[a-z]+$/i.test(word));
}

/**
 * @param {string} mnemonic
 */
function privateKeyFromMnemonic(mnemonic) {
  const account = mnemonicToAccount(mnemonic.trim(), {
    path: process.env.DSA_HD_PATH || "m/44'/60'/0'/0/0",
  });
  const hdKey = account.getHdKey();
  if (!hdKey.privateKey) {
    throw new Error("Could not derive a private key from the mnemonic phrase.");
  }

  return toHex(hdKey.privateKey);
}

/**
 * Loads a signing key for Instadapp spell casting.
 *
 * Resolution order:
 * 1. DSA_PRIVATE_KEY (EOA hex private key or mnemonic phrase — DSA authority signer)
 * 2. PRIVATE_KEY
 * 3. MNEMONIC_PHRASE (+ optional DSA_HD_PATH)
 * 4. wallet_data.txt seed (legacy CDP wallet export)
 *
 * @param {string} [walletDataPath]
 */
function resolveSigningKey(walletDataPath = path.join(process.cwd(), "wallet_data.txt")) {
  const directKey = process.env.DSA_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (directKey) {
    if (looksLikeMnemonic(directKey)) {
      return privateKeyFromMnemonic(directKey);
    }

    return normalizePrivateKey(directKey);
  }

  const mnemonic = process.env.MNEMONIC_PHRASE;
  if (mnemonic) {
    return privateKeyFromMnemonic(mnemonic);
  }

  if (fs.existsSync(walletDataPath)) {
    const walletData = JSON.parse(fs.readFileSync(walletDataPath, "utf8"));
    if (walletData.seed) {
      if (looksLikeMnemonic(walletData.seed)) {
        return privateKeyFromMnemonic(walletData.seed);
      }

      return normalizePrivateKey(walletData.seed);
    }
  }

  throw new Error(
    "No DSA signing key found. Set DSA_PRIVATE_KEY, PRIVATE_KEY, MNEMONIC_PHRASE, or reuse a legacy wallet_data.txt seed.",
  );
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
 * @returns {number | undefined}
 */
function resolvePersistedDsaId(state, chainId, signerAddress) {
  if (
    state.signerAddress &&
    state.signerAddress.toLowerCase() !== signerAddress.toLowerCase()
  ) {
    return undefined;
  }

  const chainState = state.chains?.[String(chainId)];
  if (chainState?.dsaId != null) {
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
  const chainId = options.chainId ?? resolveDsaChainId();
  const signerAddress =
    options.signerAddress ||
    web3.eth.accounts.privateKeyToAccount(resolveSigningKey()).address;
  const estimate = await estimateDsaBuildCost(dsa, web3);
  const gasFunding = await ensureDsaGas(signerAddress, chainId, "build", estimate);

  const gasPriceGwei =
    options.gasPriceGwei ||
    process.env.DSA_GAS_PRICE_GWEI ||
    (await web3.eth.getGasPrice());

  const txHash = await dsa.build({
    version: 2,
    gasPrice: gasPriceGwei,
  });

  return { txHash, gasFunding, estimate };
}

/**
 * @param {import("dsa-connect").DSA} dsa
 * @param {string} signerAddress
 * @param {{ dsaId?: number, autoBuild?: boolean, gasPriceGwei?: string }} [options]
 * @param {import("web3").Web3} web3
 */
async function ensureDsaInstance(dsa, web3, signerAddress, options = {}) {
  const chainId = options.chainId ?? resolveDsaChainId();
  const state = loadDsaState();
  const chainState = loadDsaChainState(chainId);
  const requestedId =
    options.dsaId ?? resolvePersistedDsaId(state, chainId, signerAddress);
  const accounts = await listDsaAccounts(dsa, signerAddress);

  if (requestedId != null) {
    const match = accounts.find((account) => account.id === requestedId);
    if (!match) {
      throw new Error(`DSA id ${requestedId} was not found for signer ${signerAddress}.`);
    }

    const instance = await dsa.setInstance(requestedId);
    saveDsaChainState(
      chainId,
      {
        dsaId: instance.id,
        dsaAddress: instance.address,
        lastBuildTx: chainState.lastBuildTx,
      },
      signerAddress,
    );

    return { instance, accounts, created: false };
  }

  if (accounts.length > 0) {
    const instance = await dsa.setInstance(accounts[0].id);
    saveDsaChainState(
      chainId,
      {
        dsaId: instance.id,
        dsaAddress: instance.address,
        lastBuildTx: chainState.lastBuildTx,
      },
      signerAddress,
    );

    return { instance, accounts, created: false };
  }

  if (options.autoBuild === false) {
    throw new Error(
      `No DSA accounts found for ${signerAddress}. Run "dsa build" or pass --build to create one.`,
    );
  }

  const buildResult = await buildDsaAccount(dsa, web3, { ...options, chainId, signerAddress });
  const txHash = buildResult.txHash;
  const refreshed = await listDsaAccounts(dsa, signerAddress);
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
    },
    signerAddress,
  );

  return {
    instance,
    accounts: refreshed,
    created: true,
    buildTxHash: txHash,
    gasFunding: buildResult.gasFunding,
  };
}

/**
 * @param {import("dsa-connect").DSA} dsa
 * @param {import("web3").Web3} web3
 * @param {unknown} spellsInput
 * @param {{ valueWei?: string, gasPriceGwei?: string, dryRun?: boolean }} [options]
 */
async function castSpells(dsa, web3, spellsInput, options = {}) {
  const spells = parseSpellsInput(spellsInput);
  const spellInstance = buildSpellInstance(dsa, spells);
  const chainId = options.chainId ?? resolveDsaChainId();
  const signerAddress =
    options.signerAddress ||
    web3.eth.accounts.privateKeyToAccount(resolveSigningKey()).address;
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
    gasFunding = await ensureDsaGas(signerAddress, chainId, "cast", {
      costWei: estimatedCostWei.toString(),
    });
  } catch {
    gasFunding = await ensureDsaGas(signerAddress, chainId, "cast");
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
async function estimateDsaBuildCost(dsa, web3) {
  const gasPrice = await web3.eth.getGasPrice();
  try {
    const tx = await dsa.build({ version: 2, gasPrice, return: true });
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
  const { signerAddress } = createDsaClient({ chainId: chainIds[0] });
  const summary = [];

  for (const chainId of chainIds) {
    const { dsa, web3 } = createDsaClient({ chainId });
    const label = formatChainLabel(chainId);
    const balanceWei = await web3.eth.getBalance(signerAddress);
    const accounts = await listDsaAccounts(dsa, signerAddress);
    const estimate = await estimateDsaBuildCost(dsa, web3);

    if (accounts.length > 0 && !options.force) {
      const instance = await dsa.setInstance(accounts[0].id);
      saveDsaChainState(
        chainId,
        {
          dsaId: instance.id,
          dsaAddress: instance.address,
        },
        signerAddress,
      );
      summary.push({
        chainId,
        chain: label,
        status: "exists",
        dsaId: instance.id,
        dsaAddress: instance.address,
        balanceWei: balanceWei.toString(),
      });
      continue;
    }

    const needsGas =
      estimate.costWei != null
        ? BigInt(balanceWei) < BigInt(estimate.costWei)
        : /insufficient funds|overshot/i.test(estimate.error || "");

    if (needsGas) {
      try {
        await ensureDsaGas(signerAddress, chainId, "build", estimate);
      } catch (error) {
        summary.push({
          chainId,
          chain: label,
          status: "needs_gas",
          signerAddress,
          balanceWei: balanceWei.toString(),
          requiredWei: estimate.costWei,
          requiredNative: estimate.costEth,
          estimate,
          paymasterError: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    if (estimate.error) {
      summary.push({
        chainId,
        chain: label,
        status: "error",
        signerAddress,
        balanceWei: balanceWei.toString(),
        estimate,
        error: estimate.error,
      });
      continue;
    }

    try {
      const buildResult = await buildDsaAccount(dsa, web3, { chainId, signerAddress });
      const txHash = buildResult.txHash;
      const refreshed = await listDsaAccounts(dsa, signerAddress);
      const instance = await dsa.setInstance(refreshed[0].id);
      saveDsaChainState(
        chainId,
        {
          dsaId: instance.id,
          dsaAddress: instance.address,
          lastBuildTx: txHash,
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
      });
    } catch (error) {
      summary.push({
        chainId,
        chain: label,
        status: "error",
        signerAddress,
        balanceWei: balanceWei.toString(),
        estimate,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { signerAddress, chains: summary, persisted: loadDsaState() };
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
  resolvePersistedDsaId,
  resolveRpcUrl,
  resolveSigningKey,
  saveDsaChainState,
  saveDsaState,
};
