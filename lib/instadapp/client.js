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
 * 1. DSA_PRIVATE_KEY (hex private key or mnemonic phrase)
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
 */
function loadDsaState(dataPath = path.join(process.cwd(), DSA_DATA_PATH)) {
  if (!fs.existsSync(dataPath)) {
    return {};
  }

  const raw = fs.readFileSync(dataPath, "utf8").trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

/**
 * @param {object} state
 * @param {string} [dataPath]
 */
function saveDsaState(state, dataPath = path.join(process.cwd(), DSA_DATA_PATH)) {
  fs.writeFileSync(dataPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
  const gasPriceGwei =
    options.gasPriceGwei ||
    process.env.DSA_GAS_PRICE_GWEI ||
    (await web3.eth.getGasPrice());

  return dsa.build({
    version: 2,
    gasPrice: gasPriceGwei,
  });
}

/**
 * @param {import("dsa-connect").DSA} dsa
 * @param {string} signerAddress
 * @param {{ dsaId?: number, autoBuild?: boolean, gasPriceGwei?: string }} [options]
 * @param {import("web3").Web3} web3
 */
async function ensureDsaInstance(dsa, web3, signerAddress, options = {}) {
  const state = loadDsaState();
  const requestedId = options.dsaId ?? state.dsaId;
  const accounts = await listDsaAccounts(dsa, signerAddress);

  if (requestedId != null) {
    const match = accounts.find((account) => account.id === requestedId);
    if (!match) {
      throw new Error(`DSA id ${requestedId} was not found for signer ${signerAddress}.`);
    }

    const instance = await dsa.setInstance(requestedId);
    saveDsaState({
      ...state,
      chainId: dsa.instance.chainId,
      dsaId: instance.id,
      dsaAddress: instance.address,
      signerAddress,
    });

    return { instance, accounts, created: false };
  }

  if (accounts.length > 0) {
    const instance = await dsa.setInstance(accounts[0].id);
    saveDsaState({
      ...state,
      chainId: dsa.instance.chainId,
      dsaId: instance.id,
      dsaAddress: instance.address,
      signerAddress,
    });

    return { instance, accounts, created: false };
  }

  if (options.autoBuild === false) {
    throw new Error(
      `No DSA accounts found for ${signerAddress}. Run "dsa build" or pass --build to create one.`,
    );
  }

  const txHash = await buildDsaAccount(dsa, web3, options);
  const refreshed = await listDsaAccounts(dsa, signerAddress);
  if (refreshed.length === 0) {
    throw new Error(`DSA build transaction ${txHash} was sent, but no account is visible yet.`);
  }

  const instance = await dsa.setInstance(refreshed[0].id);
  saveDsaState({
    chainId: dsa.instance.chainId,
    dsaId: instance.id,
    dsaAddress: instance.address,
    signerAddress,
    lastBuildTx: txHash,
  });

  return { instance, accounts: refreshed, created: true, buildTxHash: txHash };
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
    const gas = await spellInstance.estimateCastGas();
    return {
      dryRun: true,
      spells,
      encoded,
      estimatedGas: gas,
      castParams,
    };
  }

  const txHash = await spellInstance.cast(castParams);
  return {
    dryRun: false,
    spells,
    txHash,
    castParams,
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
  castSpells,
  createDsaClient,
  ensureDsaInstance,
  formatChainLabel,
  listDsaAccounts,
  loadDsaState,
  resolveDsaChainId,
  resolveRpcUrl,
  resolveSigningKey,
  saveDsaState,
};
