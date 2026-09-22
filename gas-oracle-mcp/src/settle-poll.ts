export interface SettlePollAttempt {
  attempt: number;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  settled: boolean;
  pending: boolean;
  error?: string;
}

export interface SettlePollResult {
  settled: boolean;
  pending: boolean;
  attempts: SettlePollAttempt[];
  transactionHash: string | null;
  recommendation: string;
  polledAt: string;
}

const HASH_RE = /^0x[a-fA-F0-9]{64}$/;

function looksSettled(payload: unknown, status: number): boolean {
  if (status < 200 || status >= 300) return false;
  if (!payload || typeof payload !== "object") return false;
  const rec = payload as Record<string, unknown>;
  if (rec.success === true) return true;
  if (rec.settled === true) return true;
  if (String(rec.status || "").toLowerCase() === "settled") return true;
  return false;
}

function extractTxHash(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as Record<string, unknown>;
  for (const key of ["transaction", "transactionHash", "txHash", "hash"]) {
    const value = rec[key];
    if (typeof value === "string" && HASH_RE.test(value)) return value;
  }
  return null;
}

export async function pollFacilitatorSettle(input: {
  facilitatorUrl: string;
  payload?: unknown;
  maxAttempts?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<SettlePollResult> {
  let parsed: URL;
  try {
    parsed = new URL(input.facilitatorUrl);
  } catch {
    throw new Error("facilitatorUrl must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("facilitatorUrl must use https");
  }

  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) {
    throw new Error("maxAttempts must be an integer between 1 and 8");
  }
  const intervalMs = input.intervalMs ?? 400;
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 5_000) {
    throw new Error("intervalMs must be an integer between 0 and 5000");
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const attempts: SettlePollAttempt[] = [];
  let settled = false;
  let pending = false;
  let transactionHash: string | null = null;

  for (let i = 1; i <= maxAttempts; i += 1) {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const res = await fetchImpl(parsed.toString(), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(input.payload ?? {}),
        signal: controller.signal,
        redirect: "manual",
      });
      clearTimeout(timer);
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      const ok = res.status > 0 && res.status < 500;
      const thisSettled = looksSettled(json, res.status);
      const hash = extractTxHash(json);
      if (hash) transactionHash = hash;
      const thisPending = Boolean(!thisSettled && hash);
      attempts.push({
        attempt: i,
        ok,
        status: res.status,
        latencyMs: Date.now() - started,
        settled: thisSettled,
        pending: thisPending,
      });
      settled = thisSettled;
      pending = thisPending;
      if (thisSettled) break;
    } catch (error) {
      attempts.push({
        attempt: i,
        ok: false,
        status: null,
        latencyMs: Date.now() - started,
        settled: false,
        pending: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (i < maxAttempts && intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  const recommendation = settled
    ? "Settlement confirmed. Deliver the paid resource."
    : pending
      ? "Transaction hash seen but not confirmed — keep polling, do not double-charge."
      : "No settlement yet. Do not treat the first failure as terminal.";

  return {
    settled,
    pending,
    attempts,
    transactionHash,
    recommendation,
    polledAt: new Date().toISOString(),
  };
}
