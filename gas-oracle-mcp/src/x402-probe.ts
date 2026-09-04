/**
 * x402 seller preflight for buyer agents.
 *
 * High-frequency SKU: before an agent pays a new endpoint it needs a machine
 * quote — HTTP status, decoded PAYMENT-REQUIRED options, cheapest accept,
 * and a buy/skip recommendation. Does not settle payment for the target.
 */
import { assertSafePublicUrl } from "./http-safety.js";
import { parseUsdAmount } from "./money.js";

const TIMEOUT_MS = 8_000;
const MAX_ENDPOINTS = 4;
const MAX_HEADER_CHARS = 16_384;

const PAYMENT_HEADER_NAMES = [
  "payment-required",
  "x-payment-required",
  "www-authenticate",
];

export interface DecodedAccept {
  scheme: string | null;
  network: string | null;
  payTo: string | null;
  asset: string | null;
  priceUsd: number | null;
  priceRaw: string | null;
  maxAmountRequired: string | null;
  resource: string | null;
  extra: Record<string, unknown> | null;
}

export interface DecodePaymentRequiredResult {
  decoded: boolean;
  source: "header" | "body" | "none";
  x402Version: number | null;
  accepts: DecodedAccept[];
  cheapest: DecodedAccept | null;
  error?: string;
}

export interface ProbeX402Result {
  probedAt: string;
  url: string;
  method: string;
  status: number;
  paymentRequired: boolean;
  decode: DecodePaymentRequiredResult;
  recommendation: string;
}

function tryJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function tryBase64Json(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    return tryJsonParse(decoded);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function extractPrice(accept: Record<string, unknown>): { priceUsd: number | null; priceRaw: string | null } {
  const raw =
    firstString(accept.price, accept.maxAmountRequired, accept.amount) ??
    (typeof accept.maxAmountRequired === "number" ? String(accept.maxAmountRequired) : null);

  if (!raw) return { priceUsd: null, priceRaw: null };

  if (raw.startsWith("$") || raw.includes(".")) {
    try {
      return { priceUsd: parseUsdAmount(raw, "price"), priceRaw: raw };
    } catch {
      return { priceUsd: null, priceRaw: raw };
    }
  }

  // Atomic units (USDC 6 decimals is the ecosystem default).
  if (/^\d+$/.test(raw)) {
    const usd = Number(raw) / 1_000_000;
    if (Number.isFinite(usd)) return { priceUsd: usd, priceRaw: raw };
  }

  return { priceUsd: null, priceRaw: raw };
}

function normalizeAccept(raw: unknown): DecodedAccept | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const { priceUsd, priceRaw } = extractPrice(rec);
  return {
    scheme: firstString(rec.scheme),
    network: firstString(rec.network),
    payTo: firstString(rec.payTo, rec.pay_to, rec.recipient),
    asset: firstString(rec.asset, rec.token),
    priceUsd,
    priceRaw,
    maxAmountRequired: firstString(rec.maxAmountRequired) ?? (typeof rec.maxAmountRequired === "number" ? String(rec.maxAmountRequired) : null),
    resource: firstString(rec.resource),
    extra: asRecord(rec.extra),
  };
}

function extractAccepts(payload: unknown): { version: number | null; accepts: DecodedAccept[] } {
  const rec = asRecord(payload);
  const versionRaw = rec?.x402Version ?? rec?.version;
  const version = typeof versionRaw === "number" ? versionRaw : null;

  const list: unknown[] = [];
  if (Array.isArray(rec?.accepts)) list.push(...rec.accepts);
  else if (Array.isArray(payload)) list.push(...payload);
  else if (rec) list.push(rec);

  const accepts = list.map(normalizeAccept).filter((row): row is DecodedAccept => row !== null);
  return { version, accepts };
}

export function decodePaymentRequiredPayload(raw: unknown): DecodePaymentRequiredResult {
  if (raw === undefined || raw === null || raw === "") {
    return { decoded: false, source: "none", x402Version: null, accepts: [], cheapest: null };
  }

  let payload: unknown = raw;
  if (typeof raw === "string") {
    const clipped = raw.length > MAX_HEADER_CHARS ? raw.slice(0, MAX_HEADER_CHARS) : raw;
    payload = tryJsonParse(clipped) ?? tryBase64Json(clipped) ?? clipped;
    if (typeof payload === "string") {
      return {
        decoded: false,
        source: "header",
        x402Version: null,
        accepts: [],
        cheapest: null,
        error: "PAYMENT-REQUIRED value was not JSON or base64 JSON",
      };
    }
  }

  const { version, accepts } = extractAccepts(payload);
  const priced = accepts
    .filter((row) => row.priceUsd !== null)
    .sort((a, b) => (a.priceUsd as number) - (b.priceUsd as number));

  return {
    decoded: accepts.length > 0,
    source: "header",
    x402Version: version,
    accepts,
    cheapest: priced[0] ?? accepts[0] ?? null,
  };
}

function pickPaymentHeader(headers: Headers): string | null {
  for (const name of PAYMENT_HEADER_NAMES) {
    const value = headers.get(name);
    if (value) return value;
  }
  return null;
}

function recommend(status: number, decode: DecodePaymentRequiredResult): string {
  if (status === 402 || decode.decoded) {
    const cheapest = decode.cheapest;
    if (cheapest?.priceUsd !== null && cheapest?.priceUsd !== undefined) {
      const net = cheapest.network ? ` on ${cheapest.network}` : "";
      return `Pay ${cheapest.priceUsd.toFixed(6)} USDC${net} then retry the same URL with PAYMENT-SIGNATURE.`;
    }
    return "Endpoint challenged with HTTP 402. Decode succeeded without a numeric price — inspect accepts before paying.";
  }
  if (status >= 200 && status < 300) {
    return "No payment required on this probe. Call the resource directly.";
  }
  return `No x402 challenge observed (HTTP ${status}). Do not attach a payment header yet.`;
}

export async function probeX402Endpoint(input: {
  url: unknown;
  method?: unknown;
}): Promise<ProbeX402Result> {
  const url = String(input.url ?? "").trim();
  if (!url) throw new Error("url is required");
  const parsed = await assertSafePublicUrl(url);

  const methodRaw = String(input.method ?? "GET").toUpperCase();
  if (methodRaw !== "GET" && methodRaw !== "HEAD") {
    throw new Error("method must be GET or HEAD");
  }

  const MAX_REDIRECTS = 4;
  let current = parsed;
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      res = await fetch(current.toString(), {
        method: methodRaw,
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/json, text/plain, */*" },
      });
    } catch (error) {
      throw new Error(
        `Probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      current = await assertSafePublicUrl(new URL(location, current).toString());
      continue;
    }
    break;
  }
  if (!res) throw new Error("Probe failed without a response");

  const headerValue = pickPaymentHeader(res.headers);
  let decode = decodePaymentRequiredPayload(headerValue);

  if (!decode.decoded && methodRaw !== "HEAD") {
    try {
      const text = await res.text();
      const bodyJson = tryJsonParse(text.slice(0, MAX_HEADER_CHARS));
      const bodyDecode = decodePaymentRequiredPayload(bodyJson ?? text.slice(0, 512));
      if (bodyDecode.decoded) {
        decode = { ...bodyDecode, source: "body" };
      }
    } catch {
      // Ignore body parse errors; header is the protocol source of truth.
    }
  }

  return {
    probedAt: new Date().toISOString(),
    url: current.toString(),
    method: methodRaw,
    status: res.status,
    paymentRequired: res.status === 402 || decode.decoded,
    decode,
    recommendation: recommend(res.status, decode),
  };
}

export async function quoteX402Bundle(input: {
  urls?: unknown;
  method?: unknown;
}): Promise<{
  comparedAt: string;
  count: number;
  cheapestPaid: ProbeX402Result | null;
  results: ProbeX402Result[];
}> {
  if (!Array.isArray(input.urls) || input.urls.length === 0) {
    throw new Error("urls must be a non-empty array");
  }
  if (input.urls.length > MAX_ENDPOINTS) {
    throw new Error(`urls supports at most ${MAX_ENDPOINTS} endpoints per call`);
  }

  const results: ProbeX402Result[] = [];
  for (const url of input.urls) {
    results.push(await probeX402Endpoint({ url, method: input.method }));
  }

  const paid = results
    .filter((row) => row.paymentRequired && row.decode.cheapest?.priceUsd != null)
    .sort(
      (a, b) =>
        (a.decode.cheapest?.priceUsd as number) - (b.decode.cheapest?.priceUsd as number),
    );

  return {
    comparedAt: new Date().toISOString(),
    count: results.length,
    cheapestPaid: paid[0] ?? null,
    results,
  };
}
