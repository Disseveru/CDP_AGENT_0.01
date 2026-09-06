/**
 * Agent-to-agent commerce trust SKUs.
 * Deterministic, no network side effects except optional facilitator HEAD probes.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX32_RE = /^0x[a-fA-F0-9]{64}$/;

export const KNOWN_STABLECOINS: Record<string, { symbol: string; decimals: number; chains: string[] }> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6, chains: ["base"] },
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6, chains: ["ethereum"] },
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { symbol: "USDC", decimals: 6, chains: ["polygon"] },
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC", decimals: 6, chains: ["arbitrum"] },
  "0x0b2c639c533813f4aa9d7837caf62653d097ff85": { symbol: "USDC", decimals: 6, chains: ["optimism"] },
};

export const DEFAULT_FACILITATORS = [
  { id: "cdp", url: "https://api.cdp.coinbase.com/platform/v2/x402", feeBps: 0 },
  { id: "xpay", url: "https://facilitator.xpay.sh", feeBps: 0 },
  { id: "x402org", url: "https://x402.org/facilitator", feeBps: 0 },
];

function mustAddress(value: unknown, label: string): `0x${string}` {
  const raw = String(value ?? "").trim();
  if (!ADDR_RE.test(raw)) throw new Error(`${label} must be a 0x-prefixed 20-byte address`);
  return raw.toLowerCase() as `0x${string}`;
}

function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

export interface DeliveryReceiptInput {
  resource: unknown;
  buyer: unknown;
  seller: unknown;
  amountUsd: unknown;
  network?: unknown;
  content?: unknown;
  secret?: unknown;
}

export interface DeliveryReceipt {
  schema: "agentwire.delivery-receipt.v1";
  resource: string;
  buyer: string;
  seller: string;
  amountUsd: string;
  network: string;
  contentHash: string;
  issuedAt: string;
  receiptId: string;
  signature: string;
}

export function issueDeliveryReceipt(input: DeliveryReceiptInput): DeliveryReceipt {
  const resource = String(input.resource ?? "").trim();
  if (!resource || resource.length > 512) throw new Error("resource must be 1-512 characters");
  const buyer = mustAddress(input.buyer, "buyer");
  const seller = mustAddress(input.seller, "seller");
  const amount = String(input.amountUsd ?? "").replace(/^\$/, "").trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(amount)) throw new Error("amountUsd must look like 0.005");
  const network = String(input.network ?? "eip155:8453").trim();
  const content = input.content === undefined ? "" : JSON.stringify(input.content);
  const contentHash = sha256Hex(content);
  const issuedAt = new Date().toISOString();
  const body = { schema: "agentwire.delivery-receipt.v1" as const, resource, buyer, seller, amountUsd: amount, network, contentHash, issuedAt };
  const receiptId = `awr_${sha256Hex(JSON.stringify(body)).slice(0, 24)}`;
  const secret = String(input.secret ?? process.env.RECEIPT_HMAC_SECRET ?? "agentwire-dev-receipt");
  const signature = createHmac("sha256", secret).update(JSON.stringify({ ...body, receiptId })).digest("hex");
  return { ...body, receiptId, signature };
}

export function verifyDeliveryReceipt(receipt: DeliveryReceipt, secret?: string): { valid: boolean; reason: string } {
  try {
    const key = secret ?? process.env.RECEIPT_HMAC_SECRET ?? "agentwire-dev-receipt";
    const { signature, ...rest } = receipt;
    const expected = createHmac("sha256", key).update(JSON.stringify(rest)).digest("hex");
    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false, reason: "HMAC mismatch" };
    }
    return { valid: true, reason: "Receipt HMAC verified" };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export interface TokenScreenInput {
  token: unknown;
  chain?: unknown;
  allowlist?: unknown;
}

export interface TokenScreenResult {
  token: string;
  chain: string;
  knownStablecoin: boolean;
  symbol: string | null;
  allowlisted: boolean;
  recommendation: "pay" | "refuse" | "review";
  reasons: string[];
  screenedAt: string;
}

export function screenTokenAllowlist(input: TokenScreenInput): TokenScreenResult {
  const token = mustAddress(input.token, "token");
  const chain = String(input.chain ?? "base").trim().toLowerCase();
  const extra = Array.isArray(input.allowlist) ? input.allowlist.map((v) => String(v).toLowerCase()) : [];
  const known = KNOWN_STABLECOINS[token];
  const knownStablecoin = Boolean(known && (!known.chains.length || known.chains.includes(chain)));
  const allowlisted = extra.includes(token) || knownStablecoin;
  const reasons: string[] = [];
  if (knownStablecoin) reasons.push(`${known?.symbol} is a known settlement asset on ${chain}`);
  if (extra.includes(token)) reasons.push("Token is on the caller allowlist");
  if (!allowlisted) reasons.push("Unknown token — refuse automatic x402 spend");
  return {
    token,
    chain,
    knownStablecoin,
    symbol: knownStablecoin ? known?.symbol ?? null : null,
    allowlisted,
    recommendation: allowlisted ? "pay" : "refuse",
    reasons,
    screenedAt: new Date().toISOString(),
  };
}

export interface FacilitatorPlanInput {
  facilitators?: unknown;
  timeoutMs?: unknown;
}

export interface FacilitatorPlanResult {
  primary: { id: string; url: string; feeBps: number } | null;
  ranked: Array<{ id: string; url: string; feeBps: number; reachable: boolean; latencyMs: number | null; error?: string }>;
  failoverOrder: string[];
  plannedAt: string;
}

export async function planFacilitatorFailover(
  input: FacilitatorPlanInput = {},
  fetchImpl: typeof fetch = fetch,
): Promise<FacilitatorPlanResult> {
  const list = Array.isArray(input.facilitators) && input.facilitators.length
    ? (input.facilitators as Array<{ id?: string; url: string; feeBps?: number }>)
    : DEFAULT_FACILITATORS;
  if (list.length > 6) throw new Error("max 6 facilitators per plan");
  const timeoutMs = Math.min(Math.max(Number(input.timeoutMs ?? 1500) || 1500, 200), 5000);

  const ranked: FacilitatorPlanResult["ranked"] = [];
  for (const item of list) {
    const url = String(item.url ?? "").trim();
    const id = String(item.id ?? url);
    const feeBps = Number(item.feeBps ?? 0);
    if (!/^https:\/\//i.test(url)) {
      ranked.push({ id, url, feeBps, reachable: false, latencyMs: null, error: "url must be https" });
      continue;
    }
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
      ranked.push({
        id,
        url,
        feeBps,
        reachable: res.status < 500,
        latencyMs: Date.now() - started,
        error: res.status >= 500 ? `http_${res.status}` : undefined,
      });
    } catch (error) {
      ranked.push({
        id,
        url,
        feeBps,
        reachable: false,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const live = ranked.filter((r) => r.reachable).sort((a, b) => (a.latencyMs ?? 9e9) - (b.latencyMs ?? 9e9) || a.feeBps - b.feeBps);
  return {
    primary: live[0] ? { id: live[0].id, url: live[0].url, feeBps: live[0].feeBps } : null,
    ranked,
    failoverOrder: live.map((r) => r.id),
    plannedAt: new Date().toISOString(),
  };
}

export function assertTxHash(hash: unknown): string {
  const raw = String(hash ?? "").trim();
  if (!HEX32_RE.test(raw)) throw new Error("hash must be a 0x-prefixed 32-byte hex string");
  return raw;
}
