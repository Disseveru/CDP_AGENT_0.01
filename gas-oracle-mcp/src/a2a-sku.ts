import { createHmac, timingSafeEqual } from "node:crypto";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const USDC_PRICE_RE = /^\$?(0|[1-9]\d*)(\.\d{1,6})?$/;

export function parseUsd(raw: unknown, label: string): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim().replace(/^\$/, "");
    if (USDC_PRICE_RE.test(trimmed)) return Number(trimmed);
    const n = Number(trimmed);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  throw new Error(`${label} must be a non-negative USD amount`);
}

export function normalizeAddress(address: string): string {
  const trimmed = address.trim();
  if (!ADDRESS_RE.test(trimmed)) {
    throw new Error("payTo must be a 20-byte 0x-prefixed EVM address");
  }
  return trimmed.toLowerCase();
}

export interface ScreenPayeeInput {
  payTo: string;
  allowlist?: string[];
  denylist?: string[];
  maxPriceUsd?: unknown;
  listedPriceUsd?: unknown;
}

export interface ScreenPayeeResult {
  allowed: boolean;
  payTo: string;
  reasons: string[];
  checks: {
    addressValid: boolean;
    onAllowlist: boolean | null;
    onDenylist: boolean;
    priceWithinCap: boolean | null;
  };
  screenedAt: string;
}

export function screenPayee(input: ScreenPayeeInput): ScreenPayeeResult {
  const reasons: string[] = [];
  let addressValid = true;
  let payTo = "";
  try {
    payTo = normalizeAddress(input.payTo);
  } catch (error) {
    addressValid = false;
    reasons.push(error instanceof Error ? error.message : String(error));
  }

  const allow = (input.allowlist ?? []).map((a) => a.trim().toLowerCase());
  const deny = (input.denylist ?? []).map((a) => a.trim().toLowerCase());
  const onDenylist = Boolean(payTo && deny.includes(payTo));
  const onAllowlist = allow.length === 0 ? null : Boolean(payTo && allow.includes(payTo));

  if (onDenylist) reasons.push("payTo is on the denylist");
  if (onAllowlist === false) reasons.push("payTo is not on the allowlist");

  let priceWithinCap: boolean | null = null;
  if (input.maxPriceUsd !== undefined && input.listedPriceUsd !== undefined) {
    const cap = parseUsd(input.maxPriceUsd, "maxPriceUsd");
    const listed = parseUsd(input.listedPriceUsd, "listedPriceUsd");
    priceWithinCap = listed <= cap;
    if (!priceWithinCap) reasons.push(`listed price ${listed} exceeds cap ${cap}`);
  }

  const allowed = addressValid && !onDenylist && onAllowlist !== false && priceWithinCap !== false;
  if (allowed) reasons.push("Payee passed hygiene, list, and optional price-cap checks.");

  return {
    allowed,
    payTo: payTo || input.payTo,
    reasons,
    checks: { addressValid, onAllowlist, onDenylist, priceWithinCap },
    screenedAt: new Date().toISOString(),
  };
}

export interface BundleLine {
  sku: string;
  priceUsd: unknown;
  qty?: unknown;
}

export interface BundleAgentQuoteResult {
  lines: Array<{ sku: string; qty: number; unitUsd: number; lineUsd: number }>;
  subtotalUsd: number;
  discountUsd: number;
  totalUsd: number;
  recommendation: string;
  quotedAt: string;
}

export function bundleAgentQuote(lines: BundleLine[], discountUsd: unknown = 0): BundleAgentQuoteResult {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 20) {
    throw new Error("lines must contain 1-20 SKUs");
  }
  const discount = parseUsd(discountUsd, "discountUsd");
  const priced = lines.map((line) => {
    const qtyRaw = line.qty === undefined ? 1 : Number(line.qty);
    if (!Number.isInteger(qtyRaw) || qtyRaw < 1 || qtyRaw > 10_000) {
      throw new Error("qty must be an integer between 1 and 10000");
    }
    const unitUsd = parseUsd(line.priceUsd, `priceUsd:${line.sku}`);
    return {
      sku: String(line.sku || "unnamed"),
      qty: qtyRaw,
      unitUsd,
      lineUsd: Number((unitUsd * qtyRaw).toFixed(6)),
    };
  });
  const subtotalUsd = Number(priced.reduce((sum, row) => sum + row.lineUsd, 0).toFixed(6));
  const totalUsd = Number(Math.max(0, subtotalUsd - discount).toFixed(6));
  return {
    lines: priced,
    subtotalUsd,
    discountUsd: discount,
    totalUsd,
    recommendation:
      totalUsd === 0
        ? "Bundle is free after discount — confirm seller still requires settlement."
        : `Pay $${totalUsd.toFixed(6)} USDC for ${priced.length} SKU(s) in one agent session.`,
    quotedAt: new Date().toISOString(),
  };
}

export interface DeliveryReceipt {
  receiptId: string;
  sku: string;
  buyer: string;
  seller: string;
  amountUsd: string;
  contentHash: string;
  issuedAt: string;
  signature: string;
}

function receiptSecret(): string {
  return process.env.RECEIPT_HMAC_SECRET?.trim() || process.env.MCP_API_KEY?.trim() || "dev-receipt-secret";
}

function signPayload(canonical: string): string {
  return createHmac("sha256", receiptSecret()).update(canonical).digest("hex");
}

function canonicalReceipt(parts: Omit<DeliveryReceipt, "signature">): string {
  return [parts.receiptId, parts.sku, parts.buyer, parts.seller, parts.amountUsd, parts.contentHash, parts.issuedAt].join("|");
}

export function issueDeliveryReceipt(input: {
  sku: string;
  buyer: string;
  seller: string;
  amountUsd: unknown;
  contentHash: string;
}): DeliveryReceipt {
  const sku = String(input.sku || "").trim();
  const buyer = String(input.buyer || "").trim();
  const seller = String(input.seller || "").trim();
  const contentHash = String(input.contentHash || "").trim();
  if (!sku || !buyer || !seller || !contentHash) {
    throw new Error("sku, buyer, seller, and contentHash are required");
  }
  if (contentHash.length < 16 || contentHash.length > 128) {
    throw new Error("contentHash must be 16-128 characters");
  }
  const amountUsd = parseUsd(input.amountUsd, "amountUsd").toFixed(6);
  const issuedAt = new Date().toISOString();
  const receiptId = createHmac("sha256", receiptSecret())
    .update(`${sku}|${buyer}|${seller}|${issuedAt}|${contentHash}`)
    .digest("hex")
    .slice(0, 32);
  const unsigned = { receiptId, sku, buyer, seller, amountUsd, contentHash, issuedAt };
  return { ...unsigned, signature: signPayload(canonicalReceipt(unsigned)) };
}

export function verifyDeliveryReceipt(receipt: DeliveryReceipt): { valid: boolean; reason: string } {
  if (!receipt || typeof receipt !== "object") {
    return { valid: false, reason: "receipt missing" };
  }
  const unsigned: Omit<DeliveryReceipt, "signature"> = {
    receiptId: receipt.receiptId,
    sku: receipt.sku,
    buyer: receipt.buyer,
    seller: receipt.seller,
    amountUsd: receipt.amountUsd,
    contentHash: receipt.contentHash,
    issuedAt: receipt.issuedAt,
  };
  const expected = signPayload(canonicalReceipt(unsigned));
  const given = String(receipt.signature || "");
  if (expected.length !== given.length) {
    return { valid: false, reason: "signature length mismatch" };
  }
  const ok = timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(given, "utf8"));
  return ok
    ? { valid: true, reason: "HMAC-SHA256 receipt verified" }
    : { valid: false, reason: "signature mismatch" };
}

export interface FacilitatorCandidate {
  name: string;
  url: string;
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

export function pickFacilitatorFailover(candidates: FacilitatorCandidate[]): {
  selected: FacilitatorCandidate | null;
  ranked: FacilitatorCandidate[];
  recommendation: string;
} {
  const ranked = [...candidates].sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9);
  });
  const selected = ranked.find((row) => row.ok) ?? null;
  return {
    selected,
    ranked,
    recommendation: selected
      ? `Use ${selected.name} (${selected.url}) — live at ${selected.latencyMs}ms.`
      : "No healthy facilitator. Delay settlement and retry.",
  };
}
