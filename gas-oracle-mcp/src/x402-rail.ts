/**
 * x402 rail helpers for buyer agents.
 *
 * Agents waste USDC on dead 402 endpoints and stale facilitators.
 * These functions probe a facilitator and parse a seller challenge
 * without signing or sending funds.
 */
import { CONFIG } from "./config.js";

const FETCH_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 32_768;

export interface FacilitatorHealthResult {
  ok: boolean;
  url: string;
  httpStatus: number | null;
  latencyMs: number;
  supportsExact: boolean | null;
  networks: string[];
  error: string | null;
  probedAt: string;
}

export interface ParsedAccept {
  scheme: string | null;
  network: string | null;
  amount: string | null;
  asset: string | null;
  payTo: string | null;
  maxTimeoutSeconds: number | null;
}

export interface SellerProbeResult {
  url: string;
  httpStatus: number | null;
  paymentRequired: boolean;
  accepts: ParsedAccept[];
  recommendation: string;
  error: string | null;
  latencyMs: number;
  probedAt: string;
}

function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

async function readLimitedText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) break;
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total > MAX_BODY_BYTES ? MAX_BODY_BYTES : total);
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.byteLength + offset > merged.byteLength
      ? chunk.subarray(0, merged.byteLength - offset)
      : chunk;
    merged.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= merged.byteLength) break;
  }
  return new TextDecoder().decode(merged);
}

export function decodePaymentRequiredHeader(raw: string | null | undefined): unknown | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  try {
    const json = Buffer.from(trimmed, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
}

export function parseAccepts(payload: unknown): ParsedAccept[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const list = Array.isArray(record.accepts)
    ? record.accepts
    : Array.isArray(payload)
      ? payload
      : [];
  return list
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const row = item as Record<string, unknown>;
      return {
        scheme: typeof row.scheme === "string" ? row.scheme : null,
        network: typeof row.network === "string" ? row.network : null,
        amount: row.amount === undefined || row.amount === null ? null : String(row.amount),
        asset: typeof row.asset === "string" ? row.asset : null,
        payTo: typeof row.payTo === "string" ? row.payTo : null,
        maxTimeoutSeconds:
          typeof row.maxTimeoutSeconds === "number" ? row.maxTimeoutSeconds : null,
      };
    });
}

export function recommendSeller(input: {
  httpStatus: number | null;
  paymentRequired: boolean;
  accepts: ParsedAccept[];
}): string {
  if (input.httpStatus === null) return "Do not pay. Endpoint did not respond.";
  if (!input.paymentRequired) {
    return input.httpStatus >= 200 && input.httpStatus < 300
      ? "Resource is free or already authorized. Do not attach a payment."
      : `Do not pay. HTTP ${input.httpStatus} is not an x402 challenge.`;
  }
  if (input.accepts.length === 0) {
    return "402 received but accepts[] is empty. Do not pay.";
  }
  const exact = input.accepts.find((row) => row.scheme === "exact" && row.payTo && row.amount);
  if (!exact) {
    return "402 received but no exact scheme with payTo+amount. Inspect before paying.";
  }
  return `Pay ${exact.amount} on ${exact.network ?? "unknown network"} to ${exact.payTo}.`;
}

export async function probeFacilitator(url = CONFIG.facilitatorUrl): Promise<FacilitatorHealthResult> {
  const started = Date.now();
  const target = url.replace(/\/$/, "");
  const candidates = [`${target}/supported`, target];
  let lastError: string | null = null;
  let lastStatus: number | null = null;

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: withTimeout(FETCH_TIMEOUT_MS),
      });
      lastStatus = res.status;
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const body = await res.json().catch(() => null);
      const kinds = Array.isArray((body as { kinds?: unknown })?.kinds)
        ? ((body as { kinds: Array<Record<string, unknown>> }).kinds)
        : [];
      const networks = kinds
        .map((row) => (typeof row.network === "string" ? row.network : null))
        .filter((value): value is string => Boolean(value));
      const supportsExact = kinds.some((row) => row.scheme === "exact") || kinds.length === 0;
      return {
        ok: true,
        url: candidate,
        httpStatus: res.status,
        latencyMs,
        supportsExact,
        networks: [...new Set(networks)],
        error: null,
        probedAt: new Date().toISOString(),
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ok: false,
    url: target,
    httpStatus: lastStatus,
    latencyMs: Date.now() - started,
    supportsExact: null,
    networks: [],
    error: lastError,
    probedAt: new Date().toISOString(),
  };
}

export async function probeSellerEndpoint(rawUrl: unknown): Promise<SellerProbeResult> {
  if (typeof rawUrl !== "string" || !/^https:\/\//i.test(rawUrl.trim())) {
    throw new Error("url must be an https URL");
  }
  const url = rawUrl.trim();
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: withTimeout(FETCH_TIMEOUT_MS),
    });
    const headerPayload = decodePaymentRequiredHeader(
      res.headers.get("PAYMENT-REQUIRED") || res.headers.get("payment-required"),
    );
    let bodyPayload: unknown = null;
    if (res.status === 402) {
      const text = await readLimitedText(res);
      try {
        bodyPayload = JSON.parse(text);
      } catch {
        bodyPayload = null;
      }
    }
    const accepts = [
      ...parseAccepts(headerPayload),
      ...parseAccepts(bodyPayload),
    ];
    const paymentRequired = res.status === 402 || accepts.length > 0;
    return {
      url,
      httpStatus: res.status,
      paymentRequired,
      accepts,
      recommendation: recommendSeller({
        httpStatus: res.status,
        paymentRequired,
        accepts,
      }),
      error: null,
      latencyMs: Date.now() - started,
      probedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      url,
      httpStatus: null,
      paymentRequired: false,
      accepts: [],
      recommendation: "Do not pay. Endpoint did not respond.",
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
      probedAt: new Date().toISOString(),
    };
  }
}
