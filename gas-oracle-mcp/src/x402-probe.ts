/**
 * Live x402 endpoint probe for buyer agents.
 *
 * Agents waste USDC hitting dead, mispriced, or v1-only sellers.
 * This SKU returns liveness, HTTP status, parsed payment terms, and a
 * buy/skip recommendation before the agent signs a payment.
 */
import { assertSafePublicUrl } from "./http-safety.js";

const PROBE_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 64_000;
const HEADER_CANDIDATES = [
  "payment-required",
  "PAYMENT-REQUIRED",
  "x-payment-required",
  "X-PAYMENT-REQUIRED",
];

export interface ProbeX402Input {
  url: unknown;
  method?: unknown;
}

export interface ParsedPaymentAccept {
  scheme?: string;
  network?: string;
  maxAmountRequired?: string;
  payTo?: string;
  asset?: string;
  extra?: Record<string, unknown>;
}

export interface ProbeX402Result {
  url: string;
  ok: boolean;
  live: boolean;
  paymentRequired: boolean;
  httpStatus: number | null;
  latencyMs: number;
  headerName: string | null;
  x402Version: number | null;
  accepts: ParsedPaymentAccept[];
  cheapestUsd: number | null;
  payTo: string | null;
  networks: string[];
  recommendation: string;
  error: string | null;
  probedAt: string;
}

function asUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("url must be a non-empty http(s) string");
  }
  return raw.trim();
}

function asMethod(raw: unknown): "GET" | "POST" | "HEAD" {
  if (raw === undefined || raw === null || raw === "") return "GET";
  const method = String(raw).toUpperCase();
  if (method === "GET" || method === "POST" || method === "HEAD") return method;
  throw new Error("method must be GET, POST, or HEAD");
}

function tryDecodeBase64Json(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to base64
  }
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function extractAccepts(payload: unknown): { version: number | null; accepts: ParsedPaymentAccept[] } {
  if (!payload || typeof payload !== "object") {
    return { version: null, accepts: [] };
  }
  const record = payload as Record<string, unknown>;
  const versionRaw = record.x402Version ?? record.x402_version;
  const version = typeof versionRaw === "number" ? versionRaw : typeof versionRaw === "string" ? Number(versionRaw) : null;

  const rawAccepts = Array.isArray(record.accepts)
    ? record.accepts
    : Array.isArray(record.paymentRequirements)
      ? record.paymentRequirements
      : record.accepts && typeof record.accepts === "object"
        ? [record.accepts]
        : [];

  const accepts: ParsedPaymentAccept[] = [];
  for (const item of rawAccepts) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    accepts.push({
      scheme: typeof row.scheme === "string" ? row.scheme : undefined,
      network: typeof row.network === "string" ? row.network : undefined,
      maxAmountRequired: typeof row.maxAmountRequired === "string" ? row.maxAmountRequired : undefined,
      payTo: typeof row.payTo === "string" ? row.payTo : undefined,
      asset: typeof row.asset === "string" ? row.asset : undefined,
      extra: row.extra && typeof row.extra === "object" ? (row.extra as Record<string, unknown>) : undefined,
    });
  }
  return { version: Number.isFinite(version) ? Number(version) : null, accepts };
}

function amountToUsd(atomic: string | undefined): number | null {
  if (!atomic) return null;
  if (!/^\d+$/.test(atomic)) return null;
  return Number(atomic) / 1_000_000;
}

function pickHeader(headers: Headers): { name: string; value: string } | null {
  for (const name of HEADER_CANDIDATES) {
    const value = headers.get(name);
    if (value) return { name, value };
  }
  return null;
}

export async function probeX402Endpoint(input: ProbeX402Input): Promise<ProbeX402Result> {
  const url = asUrl(input.url);
  const method = asMethod(input.method);
  await assertSafePublicUrl(url);

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  let httpStatus: number | null = null;
  let headerName: string | null = null;
  let payload: unknown = null;
  let error: string | null = null;

  try {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": "AgentWire-x402-probe/1.6",
      },
    });
    httpStatus = response.status;
    const header = pickHeader(response.headers);
    if (header) {
      headerName = header.name;
      payload = tryDecodeBase64Json(header.value);
    }
    if (!payload) {
      const text = await response.text();
      const clipped = text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text;
      payload = tryDecodeBase64Json(clipped);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - started;
  const parsed = extractAccepts(payload);
  const paymentRequired = httpStatus === 402 || parsed.accepts.length > 0;
  const live = httpStatus !== null && httpStatus < 500 && error === null;
  const amounts = parsed.accepts.map((row) => amountToUsd(row.maxAmountRequired)).filter((n): n is number => n !== null);
  const cheapestUsd = amounts.length ? Math.min(...amounts) : null;
  const payTo = parsed.accepts.find((row) => row.payTo)?.payTo ?? null;
  const networks = [...new Set(parsed.accepts.map((row) => row.network).filter((n): n is string => Boolean(n)))];

  let recommendation: string;
  if (!live) {
    recommendation = "Skip. Endpoint is unreachable or returning a server error.";
  } else if (!paymentRequired) {
    recommendation =
      httpStatus === 200
        ? "No payment required right now — resource may be free or already authorized."
        : `Live but not advertising x402 terms (HTTP ${httpStatus}). Do not sign a payment.`;
  } else if (cheapestUsd === null) {
    recommendation = "Payment required, but amount could not be parsed. Inspect accepts before signing.";
  } else {
    recommendation = `Ready to buy. Cheapest advertised price is $${cheapestUsd.toFixed(6)} on ${networks.join(", ") || "unspecified network"}.`;
  }

  return {
    url,
    ok: live && (paymentRequired || httpStatus === 200),
    live,
    paymentRequired,
    httpStatus,
    latencyMs,
    headerName,
    x402Version: parsed.version,
    accepts: parsed.accepts,
    cheapestUsd,
    payTo,
    networks,
    recommendation,
    error,
    probedAt: new Date().toISOString(),
  };
}

export interface RankX402Input {
  urls: unknown;
  method?: unknown;
}

export interface RankX402Result {
  ranked: ProbeX402Result[];
  cheapestLive: ProbeX402Result | null;
  comparedAt: string;
}

export async function rankX402Endpoints(input: RankX402Input): Promise<RankX402Result> {
  if (!Array.isArray(input.urls) || input.urls.length === 0) {
    throw new Error("urls must be a non-empty array of http(s) strings");
  }
  if (input.urls.length > 5) {
    throw new Error("urls is capped at 5 endpoints per call");
  }

  const ranked = await Promise.all(input.urls.map((url) => probeX402Endpoint({ url, method: input.method })));
  const buyable = ranked
    .filter((row) => row.live && row.paymentRequired && row.cheapestUsd !== null)
    .sort((a, b) => (a.cheapestUsd ?? Infinity) - (b.cheapestUsd ?? Infinity));

  return {
    ranked,
    cheapestLive: buyable[0] ?? null,
    comparedAt: new Date().toISOString(),
  };
}
