/**
 * On-chain identity for AgentWire, managed with Coinbase CDP AgentKit.
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

/** Funded legacy wallet — keep as the sole CDP identity for AgentWire. */
const CANONICAL_LEGACY_ADDRESS = "0xed7d30e8bc643503f9da261ed8e623bb6ecf6189";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLET_DATA_PATH = path.join(__dirname, "..", "wallet_data.json");

export interface CdpCredentials {
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
}

export type CdpApiCredentialIssue =
  | "ok"
  | "missing_api_key_id"
  | "missing_private_key"
  | "invalid_private_key";

export interface CdpApiCredentialDiagnostics {
  issue: CdpApiCredentialIssue;
  apiKeySource?: "CDP_API_KEY" | "CDP_API_KEY_ID";
  privateKeySource?: "CDP_PRIVATE_KEY" | "CDP_API_KEY_SECRET";
}

function resolveEnvAlias(primaryName: string, fallbackName: string): string | undefined {
  const raw = process.env[primaryName] || process.env[fallbackName];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = stripWrappingQuotes(raw).trim();
  return trimmed || undefined;
}

function resolveApiKeyId(): { value?: string; source?: "CDP_API_KEY" | "CDP_API_KEY_ID" } {
  if (process.env.CDP_API_KEY?.trim()) {
    return { value: normalizeApiKeyId(process.env.CDP_API_KEY), source: "CDP_API_KEY" };
  }
  if (process.env.CDP_API_KEY_ID?.trim()) {
    return { value: normalizeApiKeyId(process.env.CDP_API_KEY_ID), source: "CDP_API_KEY_ID" };
  }
  return {};
}

function resolvePrivateKeyRaw(): {
  value?: string;
  source?: "CDP_PRIVATE_KEY" | "CDP_API_KEY_SECRET";
} {
  if (process.env.CDP_PRIVATE_KEY?.trim()) {
    return { value: process.env.CDP_PRIVATE_KEY, source: "CDP_PRIVATE_KEY" };
  }
  if (process.env.CDP_API_KEY_SECRET?.trim()) {
    return { value: process.env.CDP_API_KEY_SECRET, source: "CDP_API_KEY_SECRET" };
  }
  return {};
}

/** Collapses stray whitespace Railway and secret managers often inject into API key IDs. */
function normalizeApiKeyId(raw: string): string {
  return stripWrappingQuotes(raw).replace(/\s+/g, "");
}

function stripWrappingQuotes(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") {
        return parsed.trim();
      }
    } catch {
      // Fall back to trimming the wrapping quotes only.
    }
    return trimmed.slice(1, -1).trim();
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function rebuildSingleLinePem(secret: string): string | undefined {
  const match = secret.match(/-----BEGIN ([^-]+)-----(.*?)-----END \1-----/);
  if (!match) {
    return undefined;
  }

  const [, type, body] = match;
  const lines = body.replace(/\s+/g, "").match(/.{1,64}/g) || [];
  return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----`;
}

function decodeBase64DerPrivateKey(secret: string): string | undefined {
  const compact = secret.replace(/\s+/g, "");
  if (!compact || /[^A-Za-z0-9+/=]/.test(compact)) {
    return undefined;
  }

  let der: Buffer;
  try {
    der = Buffer.from(compact, "base64");
  } catch {
    return undefined;
  }

  if (der.length === 0 || der.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) {
    return undefined;
  }

  for (const type of ["pkcs8", "sec1"] as const) {
    try {
      return crypto
        .createPrivateKey({ key: der, format: "der", type })
        .export({ format: "pem", type: "pkcs8" })
        .toString();
    } catch {
      // Try the next encoding candidate.
    }
  }

  return undefined;
}

function normalizePrivateKeySecret(rawSecret: string): string {
  let secret = stripWrappingQuotes(rawSecret).replace(/\\\\n/g, "\n").replace(/\\n/g, "\n").trim();
  secret = secret.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ");

  if (secret.includes("BEGIN ") && !secret.includes("\n")) {
    secret = rebuildSingleLinePem(secret) ?? rebuildSingleLinePem(secret.replace(/ +/g, "")) ?? secret;
  }

  if (!secret.includes("\n")) {
    secret = rebuildSingleLinePem(secret) ?? secret;
  }

  if (!secret.includes("BEGIN ")) {
    return decodeBase64DerPrivateKey(secret) ?? secret;
  }

  return secret;
}

function canonicalizePrivateKeySecret(secret: string): string {
  if (secret.includes("BEGIN EC PRIVATE KEY")) {
    return crypto
      .createPrivateKey({ key: secret, format: "pem", type: "sec1" })
      .export({ format: "pem", type: "pkcs8" })
      .toString();
  }

  if (secret.includes("BEGIN PRIVATE KEY")) {
    return crypto
      .createPrivateKey({ key: secret, format: "pem", type: "pkcs8" })
      .export({ format: "pem", type: "pkcs8" })
      .toString();
  }

  return secret;
}

export function diagnoseCdpApiCredentials(): CdpApiCredentialDiagnostics {
  const { value: apiKeyId, source: apiKeySource } = resolveApiKeyId();
  const { value: rawSecret, source: privateKeySource } = resolvePrivateKeyRaw();

  if (!apiKeyId) {
    return { issue: "missing_api_key_id" };
  }
  if (!rawSecret) {
    return { issue: "missing_private_key", apiKeySource };
  }

  try {
    const normalizedSecret = normalizePrivateKeySecret(rawSecret);
    const apiKeySecret = canonicalizePrivateKeySecret(normalizedSecret);
    if (!apiKeySecret.includes("BEGIN PRIVATE KEY")) {
      return { issue: "invalid_private_key", apiKeySource, privateKeySource };
    }
    crypto.createPrivateKey({ key: apiKeySecret, format: "pem", type: "pkcs8" });
    return { issue: "ok", apiKeySource, privateKeySource };
  } catch {
    return { issue: "invalid_private_key", apiKeySource, privateKeySource };
  }
}

/**
 * Reads CDP credentials from the environment, normalizing single-line PEM
 * secrets (as injected by most cloud secret managers) into valid multi-line
 * PEM, and converting EC (sec1) keys to the pkcs8 form the CDP v2 SDK expects.
 */
export function resolveCdpCredentials(): CdpCredentials {
  const { value: apiKeyId } = resolveApiKeyId();
  const { value: rawSecret } = resolvePrivateKeyRaw();
  const walletSecret = process.env.CDP_WALLET_SECRET?.trim();

  if (!apiKeyId || !rawSecret || !walletSecret) {
    throw new Error(
      "Missing CDP credentials. Set CDP_API_KEY (or CDP_API_KEY_ID), CDP_PRIVATE_KEY (or CDP_API_KEY_SECRET), and CDP_WALLET_SECRET in .env",
    );
  }

  const normalizedSecret = normalizePrivateKeySecret(rawSecret);
  const apiKeySecret = canonicalizePrivateKeySecret(normalizedSecret);

  return { apiKeyId, apiKeySecret, walletSecret };
}

/**
 * Resolves only the CDP API key pair used by the x402 facilitator.
 * Returns undefined when credentials are missing or the private key is invalid.
 */
export function resolveCdpApiCredentials(): { apiKeyId: string; apiKeySecret: string } | undefined {
  const diagnostics = diagnoseCdpApiCredentials();
  if (diagnostics.issue !== "ok") {
    return undefined;
  }

  const { value: apiKeyId } = resolveApiKeyId();
  const { value: rawSecret } = resolvePrivateKeyRaw();
  if (!apiKeyId || !rawSecret) {
    return undefined;
  }

  const normalizedSecret = normalizePrivateKeySecret(rawSecret);
  const apiKeySecret = canonicalizePrivateKeySecret(normalizedSecret);
  return { apiKeyId, apiKeySecret };
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
  const payTo =
    CONFIG.payToOverride ||
    (process.env.ALLOW_NEW_CDP_WALLET === "1" ? undefined : CANONICAL_LEGACY_ADDRESS);

  if (payTo) {
    console.log(`[wallet] Using fixed pay-to address: ${payTo}`);
    return { agentKit: null, address: payTo };
  }

  const persisted = loadPersistedAddress();
  if (!persisted) {
    throw new Error(
      `Refusing to create a new AgentWire CDP wallet. Set PAY_TO_ADDRESS=${CANONICAL_LEGACY_ADDRESS}, restore wallet_data.json, or set ALLOW_NEW_CDP_WALLET=1.`,
    );
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
