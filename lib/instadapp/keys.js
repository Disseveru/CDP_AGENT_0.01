const fs = require("fs");
const path = require("path");

const { toHex } = require("viem");
const { mnemonicToAccount } = require("viem/accounts");

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
 * Loads the EOA private key used as the Avocado owner and dsa-connect signer.
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

module.exports = {
  looksLikeMnemonic,
  normalizePrivateKey,
  privateKeyFromMnemonic,
  resolveSigningKey,
};
