/**
 * x402 seller preflight — decode 402 quotes without paying.
 * Agents use this to compare sellers, avoid dead endpoints, and pick a scheme.
 */
import { assertSafePublicUrl, sanitizeRequestHeaders } from "./http-safety.js";

const MAX_BODY = 64_000;
const DEFAULT_TIMEOUT_MS = 8_000;

export interface X402Accept {
  scheme?: string;
  network?: string;
  asset?: string;
  maxAmountRequired?: string;
  minAmountRequired?: string;
  payTo?: string;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProbeResult {
  url: string;
  method: string;
  httpStatus: number;
  paymentRequired: boolean;
  headerPresent: boolean;
  x402Version?: number;
  accepts: X402Accept[];
  cheapestUsd?: number;
  error?: string;
  latencyMs: number;
}

function headerGet(headers: Headers, name: string): string | null {
  const direct = headers.get(name);
  if (direct) return direct;
  for (const [k, v] of headers.entries()) {
    if (k.toLowerCase() === name.toLowerCase()) return v;
  }
  return null;
}

function tryDecodePaymentRequired(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    try {
      const decoded = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      return JSON.parse(decoded);
    } catch {
      return null;
    }
  }
}

function normalizeAccepts(payload: unknown): { x402Version?: number; accepts: X402Accept[] } {
  if (!payload || typeof payload !== "object") return { accepts: [] };
  const obj = payload as Record<string, unknown>;
  const version = typeof obj.x402Version === "number" ? obj.x402Version : undefined;
  const rawAccepts = Array.isArray(obj.accepts)
    ? obj.accepts
    : Array.isArray(obj.accepted)
      ? obj.accepted
      : Array.isArray(payload)
        ? payload
        : [];
  const accepts = rawAccepts
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => item as X402Accept);
  return { x402Version: version, accepts };
}

function atomicToUsd(amount?: string): number | undefined {
  if (!amount) return undefined;
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return undefined;
  if (n >= 1_000 && Number.isInteger(n)) return n / 1_000_000;
  return n;
}

export function decodePaymentRequiredPayload(raw: string): {
  rawKind: "json" | "base64" | "unknown";
  x402Version?: number;
  accepts: X402Accept[];
  cheapestUsd?: number;
} {
  const asJson = (() => {
    try {
      JSON.parse(raw.trim());
      return true;
    } catch {
      return false;
    }
  })();
  const payload = tryDecodePaymentRequired(raw);
  const { x402Version, accepts } = normalizeAccepts(payload);
  const prices = accepts
    .map((a) => atomicToUsd(String(a.maxAmountRequired ?? a.minAmountRequired ?? "")))
    .filter((n): n is number => typeof n === "number");
  return {
    rawKind: payload ? (asJson ? "json" : "base64") : "unknown",
    x402Version,
    accepts,
    cheapestUsd: prices.length ? Math.min(...prices) : undefined,
  };
}

async function readLimitedText(res: Response): Promise<string> {
  const buf = new Uint8Array(await res.arrayBuffer());
  const slice = buf.byteLength > MAX_BODY ? buf.slice(0, MAX_BODY) : buf;
  return new TextDecoder().decode(slice);
}

export async function probeX402Endpoint(input: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const parsed = await assertSafePublicUrl(input.url);
  const method = (input.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "POST"].includes(method)) {
    throw new Error("method must be GET, HEAD, or POST");
  }
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), 15_000);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(parsed.toString(), {
      method,
      headers: {
        accept: "application/json, */*",
        ...sanitizeRequestHeaders(input.headers),
      },
      redirect: "manual",
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const header = headerGet(res.headers, "PAYMENT-REQUIRED") || headerGet(res.headers, "X-PAYMENT-REQUIRED");
    let bodyPayload: unknown = null;
    if (method !== "HEAD") {
      const text = await readLimitedText(res);
      try {
        bodyPayload = JSON.parse(text);
      } catch {
        bodyPayload = null;
      }
    }
    const fromHeader = header ? tryDecodePaymentRequired(header) : null;
    const combined = fromHeader || bodyPayload;
    const { x402Version, accepts } = normalizeAccepts(combined);
    const prices = accepts
      .map((a) => atomicToUsd(String(a.maxAmountRequired ?? "")))
      .filter((n): n is number => typeof n === "number");
    return {
      url: parsed.toString(),
      method,
      httpStatus: res.status,
      paymentRequired: res.status === 402 || Boolean(header) || accepts.length > 0,
      headerPresent: Boolean(header),
      x402Version,
      accepts,
      cheapestUsd: prices.length ? Math.min(...prices) : undefined,
      latencyMs,
    };
  } catch (err) {
    return {
      url: parsed.toString(),
      method,
      httpStatus: 0,
      paymentRequired: false,
      headerPresent: false,
      accepts: [],
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function compareX402Sellers(input: {
  urls: string[];
  method?: string;
}): Promise<{
  probes: ProbeResult[];
  liveCount: number;
  cheapestLive?: { url: string; cheapestUsd: number };
}> {
  const urls = (input.urls || []).slice(0, 8);
  if (urls.length === 0) throw new Error("urls is required");
  const probes = await Promise.all(urls.map((url) => probeX402Endpoint({ url, method: input.method })));
  const live = probes.filter((p) => p.paymentRequired && typeof p.cheapestUsd === "number");
  live.sort((a, b) => (a.cheapestUsd ?? Infinity) - (b.cheapestUsd ?? Infinity));
  return {
    probes,
    liveCount: probes.filter((p) => p.paymentRequired && !p.error).length,
    cheapestLive: live[0]
      ? { url: live[0].url, cheapestUsd: live[0].cheapestUsd as number }
      : undefined,
  };
}

export function scoreSellerHealth(probe: ProbeResult): {
  score: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;
  if (probe.error) {
    reasons.push("endpoint unreachable");
    return { score: 0, reasons };
  }
  if (probe.paymentRequired) {
    score += 40;
    reasons.push("returns x402 quote");
  } else {
    reasons.push("no 402 / PAYMENT-REQUIRED observed");
  }
  if (probe.headerPresent) {
    score += 20;
    reasons.push("PAYMENT-REQUIRED header present");
  }
  if (probe.accepts.length > 0) {
    score += 20;
    reasons.push(`${probe.accepts.length} accept option(s)`);
  }
  if (probe.latencyMs < 1500) {
    score += 10;
    reasons.push("fast response");
  }
  if (probe.cheapestUsd !== undefined && probe.cheapestUsd <= 0.05) {
    score += 10;
    reasons.push("micropayment-priced");
  }
  return { score, reasons };
}
