/**
 * High-demand agent-to-agent SKUs that sit on top of existing gas/x402 tools:
 *  1. screen_pay_asset — refuse non-USDC / unknown payTo assets before signing
 *  2. allocate_agent_budget — split one USDC pot across a fleet of buyer agents
 *  3. issue_delivery_receipt — deterministic SHA-256 receipt for paid payloads
 *
 * Pure functions only. No network. Safe to unit-test without wallets.
 */
import { createHash } from "node:crypto";

import { parseUsdAmount } from "./agent-commerce.js";

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Canonical Base / Ethereum USDC addresses agents already settle with. */
export const KNOWN_USDC: Record<string, { chain: string; address: string }> = {
  "eip155:8453": {
    chain: "base",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  "eip155:1": {
    chain: "ethereum",
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  "eip155:84532": {
    chain: "base-sepolia",
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
};

export type ScreenVerdict = "allow" | "review" | "deny";

export interface ScreenPayAssetInput {
  asset?: unknown;
  network?: unknown;
  payTo?: unknown;
  amountUsd?: unknown;
  maxAmountUsd?: unknown;
}

export interface ScreenPayAssetResult {
  verdict: ScreenVerdict;
  reasons: string[];
  normalized: {
    asset: string | null;
    network: string | null;
    payTo: string | null;
    amountUsd: number | null;
    knownUsdc: boolean;
  };
  screenedAt: string;
}

function normalizeHexAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!EVM_ADDRESS_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function screenPayAsset(input: ScreenPayAssetInput): ScreenPayAssetResult {
  const reasons: string[] = [];
  const network = typeof input.network === "string" ? input.network.trim() : null;
  const assetRaw = typeof input.asset === "string" ? input.asset.trim() : null;
  const payTo = normalizeHexAddress(input.payTo);

  let amountUsd: number | null = null;
  if (input.amountUsd !== undefined && input.amountUsd !== null && input.amountUsd !== "") {
    amountUsd = parseUsdAmount(input.amountUsd, "amountUsd");
  }

  let maxAmountUsd = 5;
  if (input.maxAmountUsd !== undefined && input.maxAmountUsd !== null && input.maxAmountUsd !== "") {
    maxAmountUsd = parseUsdAmount(input.maxAmountUsd, "maxAmountUsd");
  }

  const known = network ? KNOWN_USDC[network] : undefined;
  const assetAddr = assetRaw && EVM_ADDRESS_RE.test(assetRaw) ? assetRaw.toLowerCase() : null;
  const assetSymbol = assetRaw && !assetAddr ? assetRaw.toUpperCase() : null;

  const knownUsdc =
    assetSymbol === "USDC" ||
    Boolean(known && assetAddr && assetAddr === known.address.toLowerCase());

  if (!payTo) {
    reasons.push("payTo is missing or not a valid 20-byte EVM address.");
  } else if (payTo === "0x0000000000000000000000000000000000000000") {
    reasons.push("payTo is the zero address.");
  }

  if (!assetRaw) {
    reasons.push("asset is missing. Agents should only sign USDC quotes.");
  } else if (!knownUsdc && assetSymbol && assetSymbol !== "USDC") {
    reasons.push(`asset ${assetSymbol} is not a known USD stablecoin.`);
  } else if (!knownUsdc && assetAddr && !known) {
    reasons.push("asset address is not in the built-in USDC allowlist for this network.");
  }

  if (amountUsd !== null && amountUsd > maxAmountUsd) {
    reasons.push(`amountUsd ${amountUsd} exceeds maxAmountUsd ${maxAmountUsd}.`);
  }

  let verdict: ScreenVerdict = "allow";
  if (reasons.some((r) => r.includes("zero address") || r.includes("not a known USD"))) {
    verdict = "deny";
  } else if (reasons.length > 0) {
    verdict = "review";
  } else {
    reasons.push("Asset and payTo look like a standard USDC x402 quote.");
  }

  return {
    verdict,
    reasons,
    normalized: {
      asset: assetRaw,
      network,
      payTo,
      amountUsd,
      knownUsdc,
    },
    screenedAt: new Date().toISOString(),
  };
}

export interface BudgetLine {
  agentId?: string;
  shareBps?: number;
  maxUsd?: number | string;
}

export interface AllocateAgentBudgetInput {
  totalUsd: unknown;
  reserveUsd?: unknown;
  lines: BudgetLine[];
}

export interface AllocateAgentBudgetResult {
  totalUsd: number;
  reserveUsd: number;
  allocatableUsd: number;
  allocatedUsd: number;
  leftoverUsd: number;
  lines: Array<{
    agentId: string;
    shareBps: number;
    requestedUsd: number;
    grantedUsd: number;
    capped: boolean;
  }>;
  recommendation: string;
  allocatedAt: string;
}

export function allocateAgentBudget(input: AllocateAgentBudgetInput): AllocateAgentBudgetResult {
  const totalUsd = parseUsdAmount(input.totalUsd, "totalUsd");
  const reserveUsd =
    input.reserveUsd === undefined ? 0 : parseUsdAmount(input.reserveUsd, "reserveUsd");
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new Error("lines must be a non-empty array");
  }
  if (input.lines.length > 25) {
    throw new Error("lines cannot exceed 25 agents");
  }

  const allocatableUsd = Math.max(0, Number((totalUsd - reserveUsd).toFixed(6)));
  const explicitBps = input.lines.every((l) => typeof l.shareBps === "number");
  const evenBps = Math.floor(10_000 / input.lines.length);

  const lines = input.lines.map((line, index) => {
    const agentId = line.agentId?.trim() || `agent-${index + 1}`;
    const shareBps = explicitBps ? Number(line.shareBps) : evenBps;
    if (!Number.isInteger(shareBps) || shareBps < 0 || shareBps > 10_000) {
      throw new Error(`shareBps for ${agentId} must be an integer 0..10000`);
    }
    const requestedUsd = Number(((allocatableUsd * shareBps) / 10_000).toFixed(6));
    const cap =
      line.maxUsd === undefined || line.maxUsd === null
        ? requestedUsd
        : parseUsdAmount(line.maxUsd, `lines[${index}].maxUsd`);
    const grantedUsd = Number(Math.min(requestedUsd, cap).toFixed(6));
    return {
      agentId,
      shareBps,
      requestedUsd,
      grantedUsd,
      capped: grantedUsd < requestedUsd,
    };
  });

  const allocatedUsd = Number(lines.reduce((sum, l) => sum + l.grantedUsd, 0).toFixed(6));
  const leftoverUsd = Number((totalUsd - allocatedUsd).toFixed(6));
  const recommendation =
    allocatedUsd === 0
      ? "Do not dispatch buyers. Allocatable budget is zero after reserve."
      : leftoverUsd > reserveUsd
        ? `Dispatch ${lines.length} buyer(s). Leftover $${leftoverUsd.toFixed(6)} stays in treasury.`
        : `Dispatch ${lines.length} buyer(s) at the reserve floor.`;

  return {
    totalUsd,
    reserveUsd,
    allocatableUsd,
    allocatedUsd,
    leftoverUsd,
    lines,
    recommendation,
    allocatedAt: new Date().toISOString(),
  };
}

export interface DeliveryReceiptInput {
  seller?: unknown;
  buyer?: unknown;
  resource?: unknown;
  payload?: unknown;
  amountUsd?: unknown;
  txHash?: unknown;
}

export interface DeliveryReceiptResult {
  receiptId: string;
  sha256: string;
  bytes: number;
  seller: string | null;
  buyer: string | null;
  resource: string | null;
  amountUsd: number | null;
  txHash: string | null;
  issuedAt: string;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}` + "}";
}

export function issueDeliveryReceipt(input: DeliveryReceiptInput): DeliveryReceiptResult {
  const seller = typeof input.seller === "string" ? input.seller.trim() : null;
  const buyer = typeof input.buyer === "string" ? input.buyer.trim() : null;
  const resource = typeof input.resource === "string" ? input.resource.trim() : null;
  const txHash = typeof input.txHash === "string" ? input.txHash.trim() : null;
  const amountUsd =
    input.amountUsd === undefined || input.amountUsd === null || input.amountUsd === ""
      ? null
      : parseUsdAmount(input.amountUsd, "amountUsd");

  const canonical = stableStringify({
    seller,
    buyer,
    resource,
    payload: input.payload ?? null,
    amountUsd,
    txHash,
  });
  const sha256 = createHash("sha256").update(canonical).digest("hex");
  const receiptId = `rcpt_${sha256.slice(0, 16)}`;

  return {
    receiptId,
    sha256,
    bytes: Buffer.byteLength(canonical, "utf8"),
    seller,
    buyer,
    resource,
    amountUsd,
    txHash,
    issuedAt: new Date().toISOString(),
  };
}
