/**
 * High-demand A2A commerce SKUs that agents repurchase before they spend:
 * token/allowlist screens, facilitator failover, and signed delivery receipts.
 */
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

import { checkFacilitatorHealth, type FacilitatorHealthRow } from "./agentic-discovery.js";

const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;

/** Canonical USDC addresses agents actually settle with. */
export const DEFAULT_ASSET_ALLOWLIST: ReadonlyArray<{ network: string; asset: string; symbol: string }> = [
  { network: "eip155:8453", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC" },
  { network: "base", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC" },
  { network: "eip155:1", asset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC" },
  { network: "ethereum", asset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC" },
  { network: "eip155:84532", asset: "0x036cbd53842c5426634e7929541ec2318f3d59e2", symbol: "USDC" },
  { network: "base-sepolia", asset: "0x036cbd53842c5426634e7929541ec2318f3d59e2", symbol: "USDC" },
];

export const DEFAULT_ASSET_DENYLIST: ReadonlyArray<string> = [
  "0x0000000000000000000000000000000000000000",
];

function normAddr(value: string): string {
  return value.trim().toLowerCase();
}

function normNetwork(value: string): string {
  return value.trim().toLowerCase();
}

export interface ScreenTokenArgs {
  asset: string;
  network: string;
  payTo?: string;
  extraAllowlist?: string[];
  extraDenylist?: string[];
}

export interface ScreenTokenResult {
  asset: string;
  network: string;
  payTo?: string;
  allowed: boolean;
  onDefaultAllowlist: boolean;
  onDenylist: boolean;
  symbol?: string;
  reasons: string[];
  recommendation: string;
}

export function screenTokenAllowlist(args: ScreenTokenArgs): ScreenTokenResult {
  const asset = normAddr(String(args.asset || ""));
  const network = normNetwork(String(args.network || ""));
  const payTo = args.payTo ? normAddr(String(args.payTo)) : undefined;
  if (!asset) throw new Error("asset is required");
  if (!network) throw new Error("network is required");

  const extraAllow = (args.extraAllowlist || []).map(normAddr);
  const extraDeny = (args.extraDenylist || []).map(normAddr);
  const deny = new Set([...DEFAULT_ASSET_DENYLIST, ...extraDeny]);

  const reasons: string[] = [];
  const onDenylist = deny.has(asset) || (payTo ? deny.has(payTo) : false);
  if (onDenylist) reasons.push("asset or payTo is on the denylist (zero address or operator deny)");

  const listed = DEFAULT_ASSET_ALLOWLIST.find(
    (row) => row.asset === asset && (row.network === network || row.network.split(":")[0] === network),
  );
  const onDefaultAllowlist = Boolean(listed) || extraAllow.includes(asset);
  if (listed) reasons.push(`matches default ${listed.symbol} allowlist for ${listed.network}`);
  else if (extraAllow.includes(asset)) reasons.push("matches operator extra allowlist");
  else reasons.push("asset is not on the default USDC allowlist for this network");

  if (payTo && !EVM_ADDR.test(payTo)) {
    reasons.push("payTo is not a 20-byte EVM address");
  }

  const allowed = !onDenylist && onDefaultAllowlist && (!payTo || EVM_ADDR.test(payTo));
  return {
    asset,
    network,
    payTo,
    allowed,
    onDefaultAllowlist,
    onDenylist,
    symbol: listed?.symbol,
    reasons,
    recommendation: allowed
      ? "Safe to offer this asset for A2A settlement."
      : "Do not pay this asset until it is allowlisted.",
  };
}

export interface FacilitatorChoice {
  checkedAt: string;
  selected?: FacilitatorHealthRow;
  ranked: FacilitatorHealthRow[];
  recommendation: string;
}

export async function pickFacilitatorFailover(
  args: { urls?: Array<{ id?: string; url: string }> } = {},
  deps?: Parameters<typeof checkFacilitatorHealth>[1],
): Promise<FacilitatorChoice> {
  const health = await checkFacilitatorHealth(args, deps);
  const ranked = [...health.facilitators].sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return a.latencyMs - b.latencyMs;
  });
  const selected = ranked.find((row) => row.ok);
  return {
    checkedAt: health.checkedAt,
    selected,
    ranked,
    recommendation: selected
      ? `Use ${selected.id} (${selected.latencyMs}ms).`
      : "No live facilitator. Fail closed — do not settle.",
  };
}

function receiptSecret(): string {
  return process.env.RECEIPT_HMAC_SECRET?.trim() || process.env.MCP_API_KEY?.trim() || "agentwire-dev-receipt";
}

export interface DeliveryReceiptInput {
  sku: string;
  payload: unknown;
  buyer?: string;
  seller?: string;
}

export interface DeliveryReceipt {
  sku: string;
  issuedAt: string;
  payloadSha256: string;
  buyer?: string;
  seller?: string;
  alg: "hmac-sha256";
  signature: string;
}

export function issueDeliveryReceipt(input: DeliveryReceiptInput): DeliveryReceipt {
  const sku = String(input.sku || "").trim();
  if (!sku) throw new Error("sku is required");
  const payloadSha256 = createHash("sha256")
    .update(typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload ?? null))
    .digest("hex");
  const issuedAt = new Date().toISOString();
  const body = `${sku}|${issuedAt}|${payloadSha256}|${input.buyer || ""}|${input.seller || ""}`;
  const signature = createHmac("sha256", receiptSecret()).update(body).digest("hex");
  return {
    sku,
    issuedAt,
    payloadSha256,
    buyer: input.buyer,
    seller: input.seller,
    alg: "hmac-sha256",
    signature,
  };
}

export function verifyDeliveryReceipt(receipt: DeliveryReceipt): boolean {
  const body = `${receipt.sku}|${receipt.issuedAt}|${receipt.payloadSha256}|${receipt.buyer || ""}|${receipt.seller || ""}`;
  const expected = createHmac("sha256", receiptSecret()).update(body).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(String(receipt.signature || ""), "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function a2aCommerceBundle(args: {
  asset: string;
  network: string;
  payTo?: string;
  sku: string;
  payload: unknown;
  buyer?: string;
  seller?: string;
  extraAllowlist?: string[];
  extraDenylist?: string[];
}): Promise<{
  screen: ScreenTokenResult;
  facilitator: FacilitatorChoice;
  receipt: DeliveryReceipt;
  proceed: boolean;
}> {
  const screen = screenTokenAllowlist(args);
  const facilitator = await pickFacilitatorFailover();
  const receipt = issueDeliveryReceipt({
    sku: args.sku,
    payload: args.payload,
    buyer: args.buyer,
    seller: args.seller,
  });
  return {
    screen,
    facilitator,
    receipt,
    proceed: screen.allowed && Boolean(facilitator.selected),
  };
}
