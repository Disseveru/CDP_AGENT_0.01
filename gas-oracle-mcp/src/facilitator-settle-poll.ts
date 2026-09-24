/**
 * Paid SKU: interpret a facilitator /settle or /verify poll body.
 * Does not mutate payments.ts. Fetch is injectable so tests never hit live rails.
 */

export interface SettlePollInput {
  facilitatorUrl: string;
  payload?: unknown;
  timeoutMs?: number;
}

export interface SettlePollResult {
  facilitatorUrl: string;
  ok: boolean;
  settled: boolean;
  pending: boolean;
  txHash: string | null;
  status: number | null;
  latencyMs: number | null;
  reason: string;
  polledAt: string;
}

const TX_RE = /^0x[a-fA-F0-9]{64}$/;

export function extractSettleState(body: unknown, httpStatus: number | null): {
  settled: boolean;
  pending: boolean;
  txHash: string | null;
  reason: string;
} {
  if (httpStatus !== null && httpStatus >= 500) {
    return { settled: false, pending: true, txHash: null, reason: `facilitator HTTP ${httpStatus}` };
  }

  if (body == null) {
    return { settled: false, pending: true, txHash: null, reason: "empty facilitator body" };
  }

  if (typeof body === "string") {
    const trimmed = body.trim();
    if (TX_RE.test(trimmed)) {
      return { settled: true, pending: false, txHash: trimmed.toLowerCase(), reason: "tx hash in body" };
    }
    try {
      return extractSettleState(JSON.parse(trimmed), httpStatus);
    } catch {
      return { settled: false, pending: true, txHash: null, reason: "unparseable facilitator body" };
    }
  }

  if (typeof body !== "object") {
    return { settled: false, pending: true, txHash: null, reason: "non-object facilitator body" };
  }

  const rec = body as Record<string, unknown>;
  const success =
    rec.success === true ||
    rec.settled === true ||
    String(rec.status || "").toLowerCase() === "settled" ||
    String(rec.state || "").toLowerCase() === "settled";
  const pending =
    rec.pending === true ||
    String(rec.status || "").toLowerCase() === "pending" ||
    String(rec.state || "").toLowerCase() === "pending";

  const rawHash = rec.txHash || rec.transactionHash || rec.transaction || rec.hash;
  const txHash = typeof rawHash === "string" && TX_RE.test(rawHash.trim()) ? rawHash.trim().toLowerCase() : null;

  if (success || txHash) {
    return {
      settled: true,
      pending: false,
      txHash,
      reason: txHash ? `settled tx ${txHash}` : "facilitator marked success without hash",
    };
  }
  if (pending) {
    return { settled: false, pending: true, txHash: null, reason: "facilitator reports pending" };
  }
  return { settled: false, pending: true, txHash: null, reason: "no settlement fields present" };
}

export async function pollFacilitatorSettle(
  input: SettlePollInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SettlePollResult> {
  const url = String(input.facilitatorUrl || "").trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("facilitatorUrl must be an absolute URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("facilitatorUrl must use https");
  }

  const timeoutMs = input.timeoutMs ?? 2500;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 200 || timeoutMs > 15_000) {
    throw new Error("timeoutMs must be between 200 and 15000");
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: input.payload === undefined ? "GET" : "POST",
      headers: input.payload === undefined ? undefined : { "content-type": "application/json" },
      body: input.payload === undefined ? undefined : JSON.stringify(input.payload),
      signal: controller.signal,
      redirect: "manual",
    });
    const latencyMs = Date.now() - started;
    let parsedBody: unknown = null;
    const text = await res.text();
    try {
      parsedBody = text ? JSON.parse(text) : null;
    } catch {
      parsedBody = text;
    }
    const state = extractSettleState(parsedBody, res.status);
    return {
      facilitatorUrl: url,
      ok: res.status > 0 && res.status < 500,
      settled: state.settled,
      pending: state.pending,
      txHash: state.txHash,
      status: res.status,
      latencyMs,
      reason: state.reason,
      polledAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      facilitatorUrl: url,
      ok: false,
      settled: false,
      pending: true,
      txHash: null,
      status: null,
      latencyMs: Date.now() - started,
      reason: error instanceof Error ? error.message : String(error),
      polledAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}
