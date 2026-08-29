/**
 * High-frequency A2A commerce primitives.
 *
 * These SKUs sit one layer above raw fetch/gas: they help a buying agent
 * decide whether to pay another x402 seller, how much budget to reserve,
 * and what a 402 challenge actually means — without leaking SSRF or
 * executing arbitrary payments.
 */
import { assertSafePublicUrl } from "./http-safety.js";

const PROBE_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 64_000;

export interface X402Accept {
  scheme?: string;
  network?: string;
  asset?: string;
  payTo?: string;
  price?: string;
  maxAmountRequired?: string;
  extra?: Record<string, unknown>;
}

export interface SellerProbeResult {
  url: string;
  finalUrl: string;
  status: number;
  paymentRequired: boolean;
  latencyMs: number;
  contentType: string | null;
  accepts: X402Accept[];
  cheapestUsd: number | null;
  recommended: X402Accept | null;
  wellKnown: {
    url: string;
    reachable: boolean;
    status: number | null;
  };
  warnings: string[];
  probedAt: string;
}

export interface SpendLine {
  sku: string;
  unitPriceUsd: string;
  quantity: number;
}

export interface SpendQuoteResult {
  lines: Array<SpendLine & { lineTotalUsd: string }>;
  skuTotalUsd: string;
  bufferUsd: string;
  recommendedWalletUsd: string;
  maxUnitPriceUsd: string;
  lineCount: number;
  quotedAt: string;
}

function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

function clipBody(text: string): string {
  if (text.length <= MAX_BODY_BYTES) return text;
  return text.slice(0, MAX_BODY_BYTES);
}

function parseUsdPrice(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/^\$/, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function formatUsd(n: number): string {
  return `$${n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeAccept(raw: unknown): X402Accept | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const extra = asRecord(obj.extra) ?? undefined;
  const accept: X402Accept = {
    scheme: typeof obj.scheme === "string" ? obj.scheme : undefined,
    network: typeof obj.network === "string" ? obj.network : undefined,
    asset: typeof obj.asset === "string" ? obj.asset : undefined,
    payTo: typeof obj.payTo === "string" ? obj.payTo : undefined,
    price:
      typeof obj.price === "string"
        ? obj.price
        : typeof obj.maxAmountRequired === "string"
          ? obj.maxAmountRequired
          : undefined,
    maxAmountRequired:
      typeof obj.maxAmountRequired === "string" ? obj.maxAmountRequired : undefined,
    extra,
  };
  if (!accept.scheme && !accept.network && !accept.price && !accept.payTo) {
    return null;
  }
  return accept;
}

function extractAccepts(payload: unknown): X402Accept[] {
  const root = asRecord(payload);
  const candidates: unknown[] = [];
  if (root) {
    if (Array.isArray(root.accepts)) candidates.push(...root.accepts);
    if (Array.isArray(root.paymentRequirements)) candidates.push(...root.paymentRequirements);
    if (root.accepts && !Array.isArray(root.accepts)) candidates.push(root.accepts);
  }
  if (Array.isArray(payload)) candidates.push(...payload);

  const accepts: X402Accept[] = [];
  for (const item of candidates) {
    const normalized = normalizeAccept(item);
    if (normalized) accepts.push(normalized);
  }
  return accepts;
}

function pickCheapest(accepts: X402Accept[]): { cheapestUsd: number | null; recommended: X402Accept | null } {
  let best: X402Accept | null = null;
  let bestUsd: number | null = null;
  for (const accept of accepts) {
    const usd = parseUsdPrice(accept.price) ?? parseUsdPrice(accept.maxAmountRequired);
    if (usd === null) continue;
    if (bestUsd === null || usd < bestUsd) {
      bestUsd = usd;
      best = accept;
    }
  }
  return { cheapestUsd: bestUsd, recommended: best };
}

async function safeFetch(url: string): Promise<{
  status: number;
  finalUrl: string;
  contentType: string | null;
  body: string;
  latencyMs: number;
}> {
  const parsed = await assertSafePublicUrl(url);
  const started = Date.now();
  const response = await fetch(parsed.toString(), {
    method: "GET",
    redirect: "follow",
    signal: withTimeout(PROBE_TIMEOUT_MS),
    headers: {
      accept: "application/json, text/plain, */*",
      "user-agent": "AgentWire-x402-probe/1.5",
    },
  });
  const latencyMs = Date.now() - started;
  const contentType = response.headers.get("content-type");
  const body = clipBody(await response.text());
  return {
    status: response.status,
    finalUrl: response.url || parsed.toString(),
    contentType,
    body,
    latencyMs,
  };
}

function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export async function probeX402Seller(input: { url: string }): Promise<SellerProbeResult> {
  const target = String(input.url || "").trim();
  if (!target) throw new Error("url is required");

  const primary = await safeFetch(target);
  const parsedJson = tryParseJson(primary.body);
  const accepts = extractAccepts(parsedJson);
  const { cheapestUsd, recommended } = pickCheapest(accepts);
  const warnings: string[] = [];

  if (primary.status !== 402 && accepts.length === 0) {
    warnings.push("Endpoint did not return HTTP 402 and no accepts[] were parsed");
  }
  if (primary.status === 402 && accepts.length === 0) {
    warnings.push("HTTP 402 returned but payment requirements could not be parsed");
  }

  const origin = new URL(primary.finalUrl || target);
  const wellKnownUrl = `${origin.origin}/.well-known/x402`;
  let wellKnown: SellerProbeResult["wellKnown"] = {
    url: wellKnownUrl,
    reachable: false,
    status: null,
  };
  try {
    const wk = await safeFetch(wellKnownUrl);
    wellKnown = { url: wellKnownUrl, reachable: wk.status < 500, status: wk.status };
    if (wk.status >= 400) {
      warnings.push(`/.well-known/x402 returned ${wk.status}`);
    }
  } catch (error) {
    warnings.push(
      `/.well-known/x402 unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    url: target,
    finalUrl: primary.finalUrl,
    status: primary.status,
    paymentRequired: primary.status === 402 || accepts.length > 0,
    latencyMs: primary.latencyMs,
    contentType: primary.contentType,
    accepts,
    cheapestUsd,
    recommended,
    wellKnown,
    warnings,
    probedAt: new Date().toISOString(),
  };
}

export function quoteAgentSpend(input: {
  lines: SpendLine[];
  bufferBps?: number;
}): SpendQuoteResult {
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (lines.length === 0) {
    throw new Error("lines must contain at least one SKU");
  }
  if (lines.length > 50) {
    throw new Error("Maximum 50 SKUs per quote");
  }

  const bufferBps = input.bufferBps ?? 500;
  if (!Number.isFinite(bufferBps) || bufferBps < 0 || bufferBps > 10_000) {
    throw new Error("bufferBps must be between 0 and 10000");
  }

  let skuTotal = 0;
  let maxUnit = 0;
  const priced = lines.map((line) => {
    const sku = String(line.sku || "").trim();
    if (!sku) throw new Error("each line requires a sku");
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) {
      throw new Error(`invalid quantity for ${sku}`);
    }
    const unit = parseUsdPrice(line.unitPriceUsd);
    if (unit === null) {
      throw new Error(`invalid unitPriceUsd for ${sku}`);
    }
    if (unit > maxUnit) maxUnit = unit;
    const lineTotal = unit * quantity;
    skuTotal += lineTotal;
    return {
      sku,
      unitPriceUsd: formatUsd(unit),
      quantity,
      lineTotalUsd: formatUsd(lineTotal),
    };
  });

  const buffer = skuTotal * (bufferBps / 10_000);
  return {
    lines: priced,
    skuTotalUsd: formatUsd(skuTotal),
    bufferUsd: formatUsd(buffer),
    recommendedWalletUsd: formatUsd(skuTotal + buffer),
    maxUnitPriceUsd: formatUsd(maxUnit),
    lineCount: priced.length,
    quotedAt: new Date().toISOString(),
  };
}

export interface ChallengeDecodeResult {
  paymentRequired: boolean;
  accepts: X402Accept[];
  cheapestUsd: number | null;
  recommended: X402Accept | null;
  rawType: "json" | "object" | "invalid";
  decodedAt: string;
}

export function decodePaymentChallenge(input: { payload: unknown }): ChallengeDecodeResult {
  let parsed: unknown = input.payload;
  let rawType: ChallengeDecodeResult["rawType"] = "object";

  if (typeof input.payload === "string") {
    const trimmed = input.payload.trim();
    parsed = tryParseJson(trimmed);
    rawType = parsed === null ? "invalid" : "json";
  }

  const accepts = extractAccepts(parsed);
  const { cheapestUsd, recommended } = pickCheapest(accepts);
  return {
    paymentRequired: accepts.length > 0,
    accepts,
    cheapestUsd,
    recommended,
    rawType,
    decodedAt: new Date().toISOString(),
  };
}
