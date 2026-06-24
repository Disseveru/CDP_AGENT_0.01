/**
 * Shared CDP wallet policy: reuse the funded legacy wallet, never mint new accounts.
 */
const fs = require("fs");
const path = require("path");

/** Funded legacy wallet used for AgentWire revenue and agent sessions. */
const CANONICAL_LEGACY_ADDRESS = "0xed7d30e8bc643503f9da261ed8e623bb6ecf6189";

const WALLET_DATA_PATH = path.join(process.cwd(), "wallet_data.txt");

function isTruthy(value) {
  return value === "1" || value === "true";
}

function isCloudAgentSession() {
  return process.env.CURSOR_AGENT === "1" || isTruthy(process.env.CDP_REUSE_LEGACY_WALLET);
}

function isLegacyWalletEnabled() {
  if (isTruthy(process.env.USE_EOA_WALLET) || isTruthy(process.env.USE_SMART_WALLET)) {
    return false;
  }
  if (isTruthy(process.env.USE_LEGACY_WALLET)) {
    return true;
  }
  if (isTruthy(process.env.USE_LEGACY_WALLET) === false && process.env.USE_LEGACY_WALLET === "0") {
    return false;
  }
  return isCloudAgentSession();
}

function isLegacyWalletData(walletData) {
  return Boolean(walletData && (walletData.walletId || walletData.seed || walletData.mnemonicPhrase));
}

function resolveCanonicalPayToAddress() {
  const override = process.env.PAY_TO_ADDRESS?.trim();
  if (override) {
    return override;
  }
  return CANONICAL_LEGACY_ADDRESS;
}

function parseWalletDataJson(raw) {
  if (!raw?.trim()) {
    return undefined;
  }
  return JSON.parse(raw);
}

function loadWalletDataFromEnv() {
  const inline = process.env.LEGACY_WALLET_DATA?.trim();
  if (inline) {
    return parseWalletDataJson(inline);
  }

  const filePath = process.env.LEGACY_WALLET_DATA_FILE?.trim();
  if (filePath && fs.existsSync(filePath)) {
    return parseWalletDataJson(fs.readFileSync(filePath, "utf8"));
  }

  const mnemonicPhrase = process.env.MNEMONIC_PHRASE?.trim();
  if (mnemonicPhrase) {
    return { mnemonicPhrase };
  }

  return undefined;
}

function loadWalletData() {
  if (fs.existsSync(WALLET_DATA_PATH)) {
    try {
      return parseWalletDataJson(fs.readFileSync(WALLET_DATA_PATH, "utf8"));
    } catch {
      return undefined;
    }
  }
  return loadWalletDataFromEnv();
}

function refuseNewWalletCreation(context) {
  if (isTruthy(process.env.ALLOW_NEW_CDP_WALLET)) {
    return;
  }

  throw new Error(
    [
      `Refusing to create a new CDP wallet (${context}).`,
      `Reuse the funded legacy wallet at ${resolveCanonicalPayToAddress()}.`,
      "Restore wallet_data.txt, set LEGACY_WALLET_DATA / MNEMONIC_PHRASE, or export PAY_TO_ADDRESS.",
      "Set ALLOW_NEW_CDP_WALLET=1 only when you intentionally need a fresh wallet.",
    ].join(" "),
  );
}

module.exports = {
  CANONICAL_LEGACY_ADDRESS,
  WALLET_DATA_PATH,
  isCloudAgentSession,
  isLegacyWalletEnabled,
  isLegacyWalletData,
  resolveCanonicalPayToAddress,
  loadWalletData,
  loadWalletDataFromEnv,
  refuseNewWalletCreation,
};
