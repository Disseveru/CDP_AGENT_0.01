/**
 * Probe a public URL for a valid x402 payment envelope (or free 2xx).
 * Agents use this before spending so they do not pay dead Bazaar listings.
 */
import { assertSafePublicUrl, sanitizeRequestHeaders } from "./http-safety.js";

const PROBE_TIMEOUT_MS = 12_000;

export interface ProbeResourceInput {
  url: string;
  method?: "GET" | "POST" | "HEAD";
  headers?: Record<string, string>;
  body?: unknown;
}

export interface X402AcceptSummary {
  scheme?: string;
  network?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
}

export interface ProbeResourceResult {
  timestamp: string;
  url: string;
  method: string;
  status: number;
  reachable: boolean;
  /** True when HTTP 402 with a parseable x402 payment requirement. */
  paymentRequired: boolean;
  /** True when resource returned 2xx without a payment challenge (free / misconfigured). */
  freeAccess: boolean;
  /** True when listing is effectively dead for agents (404/5xx/timeout/invalid). */
  dead: boolean;
  x402Version?: number | string;
  accepts: X402AcceptSummary[];
  error?: string;
  latencyMs: number;
  contentType?: string;
}

function summarizeAccepts(body: unknown): {
  x402Version?: number | string;
  accepts: X402AcceptSummary[];
} {
  if (!body || typeof body !== "object") {
    return { accepts: [] };
  }
  const record = body as Record<string, unknown>;
  const x402Version = record.x402Version as number | string | undefined;
  const acceptsRaw = record.accepts;
  if (!Array.isArray(acceptsRaw)) {
    return { x402Version, accepts: [] };
  }

  const accepts: X402AcceptSummary[] = acceptsRaw.slice(0, 12).map((item) => {
    const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return {
      scheme: typeof row.scheme === "string" ? row.scheme : undefined,
      network: typeof row.network === "string" ? row.network : undefined,
      amount: row.amount !== undefined ? String(row.amount) : undefined,
      asset: typeof row.asset === "string" ? row.asset : undefined,
      payTo: typeof row.payTo === "string" ? row.payTo : undefined,
      maxTimeoutSeconds:
        typeof row.maxTimeoutSeconds === "number" ? row.maxTimeoutSeconds : undefined,
    };
  });

  return { x402Version, accepts };
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

/** Probe a public resource for x402 payment requirements without paying. */
export async function probeResource(input: ProbeResourceInput): Promise<ProbeResourceResult> {
  const started = Date.now();
  const method = (input.method || "GET").toUpperCase() as "GET" | "POST" | "HEAD";
  if (method !== "GET" && method !== "POST" && method !== "HEAD") {
    throw new Error('method must be "GET", "POST", or "HEAD"');
  }

  const parsed = await assertSafePublicUrl(input.url);
  const headers = sanitizeRequestHeaders(input.headers);
  if (!headers.Accept) {
    headers.Accept = "application/json, text/plain, */*";
  }

  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD" && input.body !== undefined) {
    body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
    if (!headers["Content-Type"] && typeof input.body !== "string") {
      headers["Content-Type"] = "application/json";
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(parsed.toString(), {
      method,
      headers,
      body,
      redirect: "follow",
      signal: controller.signal,
    });

    const contentType = res.headers.get("content-type") || undefined;
    const latencyMs = Date.now() - started;
    const payload = method === "HEAD" ? null : await parseBody(res);
    const { x402Version, accepts } = summarizeAccepts(payload);
    const paymentHeader =
      res.headers.get("payment-required") ||
      res.headers.get("PAYMENT-REQUIRED") ||
      res.headers.get("x-payment-required");

    const paymentRequired =
      res.status === 402 && (accepts.length > 0 || Boolean(paymentHeader));
    const freeAccess = res.status >= 200 && res.status < 300;
    const dead =
      res.status === 404 ||
      res.status === 410 ||
      res.status >= 500 ||
      (res.status === 402 && !paymentRequired);

    return {
      timestamp: new Date().toISOString(),
      url: parsed.toString(),
      method,
      status: res.status,
      reachable: true,
      paymentRequired,
      freeAccess,
      dead,
      x402Version,
      accepts,
      latencyMs,
      contentType,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      timestamp: new Date().toISOString(),
      url: parsed.toString(),
      method,
      status: 0,
      reachable: false,
      paymentRequired: false,
      freeAccess: false,
      dead: true,
      accepts: [],
      error: message,
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
