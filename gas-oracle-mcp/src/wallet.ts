/**
 * On-chain identity for the oracle, managed with Coinbase CDP AgentKit.
 *
 * The server's revenue wallet is a CDP v2 server wallet created (or reloaded)
 * through AgentKit's CdpEvmWalletProvider. Its address is the `payTo` target
 * for every x402 payment this service receives.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentKit, CdpEvmWalletProvider, walletActionProvider } from "@coinbase/agentkit";
import { isAddress } from "viem";

import { CONFIG } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLET_DATA_PATH = path.join(__dirname, "..", "wallet_data.json");

export interface CdpCredentials {
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
}

/**
 * Reads CDP credentials from the environment, normalizing single-line PEM
 * secrets (as injected by most cloud secret managers) into valid multi-line
 * PEM, and converting EC (sec1) keys to the pkcs8 form the CDP v2 SDK expects.
 */
export function resolveCdpCredentials(): CdpCredentials {
  const apiKeyId = process.env.CDP_API_KEY;
  const rawSecret = process.env.CDP_PRIVATE_KEY;
  const walletSecret = process.env.CDP_WALLET_SECRET;

  if (!apiKeyId || !rawSecret || !walletSecret) {
    throw new Error(
      "Missing CDP credentials. Set CDP_API_KEY, CDP_PRIVATE_KEY, and CDP_WALLET_SECRET in .env",
    );
  }

  let pem = rawSecret.replace(/\\n/g, "\n").trim();
  if (!pem.includes("\n")) {
    const match = pem.match(/-----BEGIN ([^-]+)-----(.*?)-----END \1-----/);
    if (match) {
      const [, type, body] = match;
      const lines = body.replace(/\s+/g, "").match(/.{1,64}/g) || [];
      pem = `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----`;
    }
  }

  const apiKeySecret = pem.includes("BEGIN EC PRIVATE KEY")
    ? crypto
        .createPrivateKey({ key: pem, format: "pem", type: "sec1" })
        .export({ format: "pem", type: "pkcs8" })
        .toString()
    : pem;

  return { apiKeyId, apiKeySecret, walletSecret };
}

function loadPersistedAddress(): `0x${string}` | undefined {
  try {
    const raw = fs.readFileSync(WALLET_DATA_PATH, "utf8");
    const parsed = JSON.parse(raw) as { address?: unknown };
    return typeof parsed.address === "string" && isAddress(parsed.address)
      ? (parsed.address as `0x${string}`)
      : undefined;
  } catch {
    return undefined;
  }
}

export interface OracleIdentity {
  agentKit: AgentKit | null;
  address: string;
}

/**
 * Initializes AgentKit with a CDP v2 server wallet and returns the revenue
 * address. The address is persisted to wallet_data.json so restarts reuse
 * the same wallet.
 *
 * If PAY_TO_ADDRESS is set, CDP wallet creation is skipped entirely and
 * `agentKit` is returned as `null`.
 */
export async function initializeOracleIdentity(): Promise<OracleIdentity> {
  if (CONFIG.payToOverride) {
    console.log(`[wallet] Using fixed PAY_TO_ADDRESS: ${CONFIG.payToOverride}`);
    return { agentKit: null, address: CONFIG.payToOverride };
  }

  const credentials = resolveCdpCredentials();

  const walletProvider = await CdpEvmWalletProvider.configureWithWallet({
    apiKeyId: credentials.apiKeyId,
    apiKeySecret: credentials.apiKeySecret,
    walletSecret: credentials.walletSecret,
    networkId: CONFIG.agentKitNetworkId,
    address: loadPersistedAddress(),
  });

  const agentKit = await AgentKit.from({
    walletProvider,
    actionProviders: [walletActionProvider()],
  });

  const address = walletProvider.getAddress();
  fs.writeFileSync(WALLET_DATA_PATH, JSON.stringify({ address }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });

  console.log(`[wallet] CDP AgentKit wallet ready on ${CONFIG.agentKitNetworkId}: ${address}`);
  return { agentKit, address };
}
