/**
 * x402 marketplace SKUs: decode 402 challenges, normalize seller quotes,
 * and probe whether an HTTP endpoint actually speaks x402.
 *
 * These do not sign payments or hold buyer keys. They sell decision data
 * that buyer agents need before they spend USDC.
 */
import { parseUsdAmount } from "./agent-commerce.js";
import { assertSafePublicUrl } from "./http-safety.js";

const MAX_PROBE_BODY = 32_768;
const PROBE_TIMEOUT_MS = 8_000;

export interface DecodedRequirement {
  scheme: string | null;
  network: string | null;
  asset: string | null;
  payTo: string | null;
  maxAmountRequired: string | null;
  maxAmountUsd: number | null;
  extra: Record<string, unknown>;
}

export interface Decode402Result {
  httpStatus: number | null;
  paymentRequired: boolean;
  requirementCount: number;
  cheapestUsd: number | null;
  requirements: DecodedRequirement[];
  warnings: string[];
  decodedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseAtomicUsd(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\$?\d+(\.\d{1,6})?$/.test(trimmed.replace(/^\$/, ""))) {
    return Number(trimmed.replace(/^\$/, ""));
  }
  if (/^\d+$/.test(trimmed) && trimmed.length > 6) {
    return Number(trimmed) / 1_000_000;
  }
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n >= 1_000 ? n / 1_000_000 : n;
  }
  try {
    return parseUsdAmount(trimmed, "amount");
  } catch {
    return null;
  }
}

export function decode402Payload(payload: unknown, httpStatus?: number): Decode402Result {
  const warnings: string[] = [];
  const requirements: DecodedRequirement[] = [];
  const root = asRecord(payload);
  let list: unknown[] = [];

  if (Array.isArray(payload)) {
    list = payload;
  } else if (root) {
    const accepts = root.accepts ?? root.paymentRequirements ?? root.requirements ?? root.x402;
    if (Array.isArray(accepts)) list = accepts;
    else if (asRecord(accepts)) list = [accepts];
    else if (root.maxAmountRequired || root.payTo || root.network) list = [root];
    else warnings.push("Payload did not contain an accepts[] array or a single requirement object.");
  } else {
    warnings.push("Payload is not a JSON object or array.");
  }

  for (const item of list.slice(0, 24)) {
    const rec = asRecord(item);
    if (!rec) continue;
    const maxAmountRequired =
      pickString(rec, ["maxAmountRequired", "amount", "price", "maxAmount"]) ?? null;
    requirements.push({
      scheme: pickString(rec, ["scheme"]),
      network: pickString(rec, ["network", "chain", "caip2"]),
      asset: pickString(rec, ["asset", "token", "currency"]),
      payTo: pickString(rec, ["payTo", "pay_to", "recipient", "to"]),
      maxAmountRequired,
      maxAmountUsd: parseAtomicUsd(maxAmountRequired),
      extra: rec,
    });
  }

  const priced = requirements
    .map((r) => r.maxAmountUsd)
    .filter((n): n is number => n !== null && Number.isFinite(n));

  const status = httpStatus ?? (asRecord(payload)?.status as number | undefined) ?? null;
  const paymentRequired = status === 402 || requirements.length > 0;

  return {
    httpStatus: typeof status === "number" ? status : null,
    paymentRequired,
    requirementCount: requirements.length,
    cheapestUsd: priced.length ? Math.min(...priced) : null,
    requirements,
    warnings,
    decodedAt: new Date().toISOString(),
  };
}

export interface SellerQuote {
  name?: unknown;
  url?: unknown;
  priceUsd?: unknown;
  network?: unknown;
}

export interface CompareSellerQuotesResult {
  compared: number;
  cheapest: { name: string; url: string | null; priceUsd: number; network: string | null } | null;
  ranked: Array<{
    name: string;
    url: string | null;
    priceUsd: number | null;
    network: string | null;
    error?: string;
  }>;
  savingsVsMostExpensiveUsd: number | null;
  comparedAt: string;
}

export function compareSellerQuotes(quotes: SellerQuote[]): CompareSellerQuotesResult {
  if (!Array.isArray(quotes) || quotes.length === 0) {
    throw new Error("quotes must be a non-empty array");
  }
  if (quotes.length > 20) {
    throw new Error("quotes is capped at 20 sellers per call");
  }

  const ranked = quotes.map((q, index) => {
    const name = typeof q.name === "string" && q.name.trim() ? q.name.trim() : `seller_${index + 1}`;
    const url = typeof q.url === "string" ? q.url : null;
    const network = typeof q.network === "string" ? q.network : null;
    try {
      return {
        name,
        url,
        priceUsd: parseUsdAmount(q.priceUsd, `${name}.priceUsd`),
        network,
      };
    } catch (error) {
      return {
        name,
        url,
        priceUsd: null,
        network,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const priced = ranked
    .filter((row) => row.priceUsd !== null)
    .sort((a, b) => Number(a.priceUsd) - Number(b.priceUsd));

  const cheapest = priced[0]
    ? {
        name: priced[0].name,
        url: priced[0].url,
        priceUsd: priced[0].priceUsd as number,
        network: priced[0].network,
      }
    : null;

  const mostExpensive = priced[priced.length - 1]?.priceUsd ?? null;
  const savingsVsMostExpensiveUsd =
    cheapest && mostExpensive !== null
      ? Number((mostExpensive - cheapest.priceUsd).toFixed(6))
      : null;

  return {
    compared: quotes.length,
    cheapest,
    ranked,
    savingsVsMostExpensiveUsd,
    comparedAt: new Date().toISOString(),
  };
}

export interface ProbeX402Result {
  url: string;
  reachable: boolean;
  httpStatus: number | null;
  latencyMs: number;
  speaksX402: boolean;
  hasWellKnownManifest: boolean;
  decode: Decode402Result | null;
  recommendation: string;
  probedAt: string;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeX402Endpoint(input: {
  url: unknown;
  method?: unknown;
}): Promise<ProbeX402Result> {
  const parsed = await assertSafePublicUrl(String(input.url ?? ""));
  const url = parsed.toString();
  const method = String(input.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    throw new Error("probe method must be GET, HEAD, or OPTIONS");
  }

  const started = Date.now();
  let reachable = false;
  let httpStatus: number | null = null;
  let decode: Decode402Result | null = null;
  let hasWellKnownManifest = false;

  try {
    const response = await fetchWithTimeout(url, {
      method,
      headers: { accept: "application/json, */*" },
    });
    reachable = true;
    httpStatus = response.status;
    const text = await response.text();
    const clipped = text.slice(0, MAX_PROBE_BODY);
    try {
      decode = decode402Payload(JSON.parse(clipped), response.status);
    } catch {
      decode = decode402Payload({ raw: clipped.slice(0, 500) }, response.status);
    }
  } catch (error) {
    decode = {
      httpStatus: null,
      paymentRequired: false,
      requirementCount: 0,
      cheapestUsd: null,
      requirements: [],
      warnings: [error instanceof Error ? error.message : String(error)],
      decodedAt: new Date().toISOString(),
    };
  }

  try {
    const origin = new URL(url).origin;
    const manifest = await fetchWithTimeout(`${origin}/.well-known/x402.json`, { method: "GET" });
    hasWellKnownManifest = manifest.ok;
  } catch {
    hasWellKnownManifest = false;
  }

  const speaksX402 = Boolean(
    httpStatus === 402 || (decode && decode.requirementCount > 0) || hasWellKnownManifest,
  );

  let recommendation: string;
  if (!reachable) recommendation = "Do not pay. Endpoint was unreachable.";
  else if (speaksX402 && decode?.cheapestUsd != null)
    recommendation = `Speaks x402. Cheapest listed price ≈ $${decode.cheapestUsd}. Pay only after wallet policy checks.`;
  else if (speaksX402)
    recommendation = "Speaks x402 but price was not machine-readable. Inspect accepts[] before paying.";
  else recommendation = "No x402 challenge detected. Treat as a free or non-x402 endpoint.";

  return {
    url,
    reachable,
    httpStatus,
    latencyMs: Date.now() - started,
    speaksX402,
    hasWellKnownManifest,
    decode,
    recommendation,
    probedAt: new Date().toISOString(),
  };
}
