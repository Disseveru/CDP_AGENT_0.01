import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { issueDeliveryReceipt, parseUsd, quoteSlaEscrow } from "./a2a-sku.js";

const SECRET_KEY_RE = /^(authorization|api[_-]?key|private[_-]?key|secret|password|cookie|x-payment|payment-signature)$/i;
const MAX_JSON_BYTES = 24_576;
const MAX_DEPTH = 6;

function sessionSecret(): string {
  return process.env.PAY_SESSION_HMAC_SECRET?.trim() || process.env.MCP_API_KEY?.trim() || "dev-session-secret";
}

function sign(canonical: string): string {
  return createHmac("sha256", sessionSecret()).update(canonical).digest("hex");
}

export interface PaySession {
  sessionId: string;
  parentAgent: string;
  childAgent: string;
  budgetUsd: string;
  spentUsd: string;
  remainingUsd: string;
  allowlistSkus: string[];
  expiresAt: string;
  issuedAt: string;
  signature: string;
}

function canonicalSession(s: Omit<PaySession, "signature">): string {
  return [
    s.sessionId,
    s.parentAgent,
    s.childAgent,
    s.budgetUsd,
    s.spentUsd,
    s.remainingUsd,
    s.allowlistSkus.join(","),
    s.expiresAt,
    s.issuedAt,
  ].join("|");
}

export function issuePaySession(input: {
  parentAgent: string;
  childAgent: string;
  budgetUsd: unknown;
  allowlistSkus?: string[];
  ttlSeconds?: unknown;
}): PaySession {
  const parentAgent = String(input.parentAgent || "").trim();
  const childAgent = String(input.childAgent || "").trim();
  if (!parentAgent || !childAgent) throw new Error("parentAgent and childAgent are required");
  const budget = parseUsd(input.budgetUsd, "budgetUsd");
  if (budget <= 0 || budget > 10_000) throw new Error("budgetUsd must be between 0 exclusive and 10000");
  const ttl = input.ttlSeconds === undefined ? 3600 : Number(input.ttlSeconds);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86_400) {
    throw new Error("ttlSeconds must be an integer between 60 and 86400");
  }
  const allowlistSkus = (input.allowlistSkus ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 40);
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const sessionId = createHmac("sha256", sessionSecret())
    .update(`${parentAgent}|${childAgent}|${issuedAt}|${budget}`)
    .digest("hex")
    .slice(0, 32);
  const unsigned: Omit<PaySession, "signature"> = {
    sessionId,
    parentAgent,
    childAgent,
    budgetUsd: budget.toFixed(6),
    spentUsd: (0).toFixed(6),
    remainingUsd: budget.toFixed(6),
    allowlistSkus,
    expiresAt,
    issuedAt,
  };
  return { ...unsigned, signature: sign(canonicalSession(unsigned)) };
}

export function verifyPaySession(session: PaySession): { valid: boolean; reason: string } {
  if (!session || typeof session !== "object") return { valid: false, reason: "session missing" };
  const unsigned: Omit<PaySession, "signature"> = {
    sessionId: session.sessionId,
    parentAgent: session.parentAgent,
    childAgent: session.childAgent,
    budgetUsd: session.budgetUsd,
    spentUsd: session.spentUsd,
    remainingUsd: session.remainingUsd,
    allowlistSkus: session.allowlistSkus ?? [],
    expiresAt: session.expiresAt,
    issuedAt: session.issuedAt,
  };
  const expected = sign(canonicalSession(unsigned));
  const given = String(session.signature || "");
  if (expected.length !== given.length) return { valid: false, reason: "signature length mismatch" };
  const ok = timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(given, "utf8"));
  if (!ok) return { valid: false, reason: "signature mismatch" };
  if (Date.parse(session.expiresAt) <= Date.now()) return { valid: false, reason: "session expired" };
  return { valid: true, reason: "pay session HMAC verified and unexpired" };
}

export function consumePaySession(input: {
  session: PaySession;
  sku: string;
  amountUsd: unknown;
}): { allowed: boolean; session?: PaySession; reason: string } {
  const check = verifyPaySession(input.session);
  if (!check.valid) return { allowed: false, reason: check.reason };
  const sku = String(input.sku || "").trim();
  if (!sku) return { allowed: false, reason: "sku required" };
  const allow = input.session.allowlistSkus ?? [];
  if (allow.length > 0 && !allow.includes(sku)) {
    return { allowed: false, reason: `sku ${sku} is not on the session allowlist` };
  }
  const amount = parseUsd(input.amountUsd, "amountUsd");
  const remaining = parseUsd(input.session.remainingUsd, "remainingUsd");
  if (amount > remaining) {
    return { allowed: false, reason: `amount ${amount} exceeds remaining ${remaining}` };
  }
  const spent = Number((parseUsd(input.session.spentUsd, "spentUsd") + amount).toFixed(6));
  const nextRemaining = Number((remaining - amount).toFixed(6));
  const next: Omit<PaySession, "signature"> = {
    sessionId: input.session.sessionId,
    parentAgent: input.session.parentAgent,
    childAgent: input.session.childAgent,
    budgetUsd: input.session.budgetUsd,
    spentUsd: spent.toFixed(6),
    remainingUsd: nextRemaining.toFixed(6),
    allowlistSkus: input.session.allowlistSkus ?? [],
    expiresAt: input.session.expiresAt,
    issuedAt: input.session.issuedAt,
  };
  return {
    allowed: true,
    session: { ...next, signature: sign(canonicalSession(next)) },
    reason: `debited ${amount.toFixed(6)} USDC; ${nextRemaining.toFixed(6)} remaining`,
  };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function walk(value: unknown, depth: number, findings: string[]): unknown {
  if (depth > MAX_DEPTH) {
    findings.push("payload exceeds max object depth");
    return "[truncated-depth]";
  }
  if (Array.isArray(value)) {
    if (value.length > 50) findings.push("array longer than 50 items");
    return value.slice(0, 50).map((item) => walk(item, depth + 1, findings));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(key)) {
        findings.push(`redacted secret-like key: ${key}`);
        out[key] = "[redacted]";
        continue;
      }
      out[key] = walk(child, depth + 1, findings);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 2048) {
    findings.push("string field truncated at 2048 chars");
    return `${value.slice(0, 2048)}…`;
  }
  return value;
}

export function validateSellerPayload(input: {
  payload: unknown;
  requiredKeys?: string[];
}): {
  ok: boolean;
  bytes: number;
  findings: string[];
  redacted: unknown;
  contentHash: string;
} {
  const findings: string[] = [];
  if (input.payload === undefined) throw new Error("payload is required");
  const bytes = jsonBytes(input.payload);
  if (bytes > MAX_JSON_BYTES) {
    findings.push(`payload is ${bytes} bytes; max is ${MAX_JSON_BYTES}`);
  }
  const redacted = walk(input.payload, 0, findings);
  const required = input.requiredKeys ?? [];
  if (required.length && (typeof input.payload !== "object" || input.payload === null || Array.isArray(input.payload))) {
    findings.push("payload must be an object to check requiredKeys");
  } else {
    const obj = (input.payload ?? {}) as Record<string, unknown>;
    for (const key of required.slice(0, 20)) {
      if (!(key in obj)) findings.push(`missing required key: ${key}`);
    }
  }
  const contentHash = createHash("sha256").update(JSON.stringify(redacted)).digest("hex");
  return {
    ok: findings.every((f) => f.startsWith("redacted") || f.startsWith("string field")),
    bytes,
    findings,
    redacted,
    contentHash,
  };
}

export function buildSellerDossier(input: {
  host?: string;
  payload?: unknown;
  uniquePayers30d?: unknown;
  medianTicketUsd?: unknown;
}): {
  host: string;
  score: number;
  flags: string[];
  hygiene: {
    hasAccepts: boolean;
    schemeOk: boolean;
    networkOk: boolean;
    payToLooksEvm: boolean;
  };
  recommendation: string;
  builtAt: string;
} {
  const flags: string[] = [];
  const host = String(input.host || "").trim().toLowerCase();
  if (host && !/^[a-z0-9.-]+$/.test(host)) flags.push("host contains unexpected characters");
  const payload = input.payload && typeof input.payload === "object" ? (input.payload as Record<string, unknown>) : {};
  const accepts = Array.isArray(payload.accepts) ? payload.accepts : [];
  const first = (accepts[0] ?? {}) as Record<string, unknown>;
  const scheme = String(first.scheme || "").toLowerCase();
  const network = String(first.network || "").toLowerCase();
  const payTo = String(first.payTo || "");
  const hygiene = {
    hasAccepts: accepts.length > 0,
    schemeOk: scheme === "exact" || scheme === "upto",
    networkOk: network.startsWith("eip155:") || network.includes("solana") || network.includes("base"),
    payToLooksEvm: /^0x[a-fA-F0-9]{40}$/.test(payTo),
  };
  if (!hygiene.hasAccepts) flags.push("no accepts[] in 402 payload");
  if (!hygiene.schemeOk) flags.push("scheme is not exact|upto");
  if (!hygiene.networkOk) flags.push("network is not a known CAIP-2 / solana / base id");
  if (accepts.length && !hygiene.payToLooksEvm && !network.includes("solana")) {
    flags.push("payTo is not a 20-byte EVM address");
  }
  const payers = input.uniquePayers30d === undefined ? null : Number(input.uniquePayers30d);
  const median = input.medianTicketUsd === undefined ? null : parseUsd(input.medianTicketUsd, "medianTicketUsd");
  if (payers !== null && (!Number.isFinite(payers) || payers < 0)) flags.push("uniquePayers30d invalid");
  if (payers !== null && payers < 3) flags.push("fewer than 3 unique payers in 30d — treat as thin liquidity");
  if (median !== null && median > 1) flags.push("median ticket > $1 — unusual for x402 micropay loops");

  let score = 70;
  if (hygiene.hasAccepts) score += 8;
  if (hygiene.schemeOk) score += 6;
  if (hygiene.networkOk) score += 6;
  if (hygiene.payToLooksEvm) score += 4;
  if (payers !== null && payers >= 10) score += 6;
  score -= flags.length * 8;
  score = Math.max(0, Math.min(100, score));

  return {
    host: host || "unknown",
    score,
    flags,
    hygiene,
    recommendation:
      score >= 70
        ? "Host looks payment-shaped. Still cap child-agent spend with issue_pay_session."
        : "Do not auto-pay. Probe the endpoint and require a pay session allowlist.",
    builtAt: new Date().toISOString(),
  };
}

export function receiptSlaPack(input: {
  sku: string;
  buyer: string;
  seller: string;
  amountUsd: unknown;
  payload?: unknown;
  slaHours?: unknown;
  penaltyBps?: unknown;
}): {
  contentHash: string;
  receipt: ReturnType<typeof issueDeliveryReceipt>;
  sla: ReturnType<typeof quoteSlaEscrow>;
  recommendation: string;
} {
  const validated = validateSellerPayload({ payload: input.payload ?? { sku: input.sku } });
  const receipt = issueDeliveryReceipt({
    sku: input.sku,
    buyer: input.buyer,
    seller: input.seller,
    amountUsd: input.amountUsd,
    contentHash: validated.contentHash.slice(0, 64),
  });
  const sla = quoteSlaEscrow({
    serviceUsd: input.amountUsd,
    slaHours: input.slaHours ?? 1,
    penaltyBps: input.penaltyBps,
  });
  return {
    contentHash: validated.contentHash,
    receipt,
    sla,
    recommendation: `Attach receipt ${receipt.receiptId} to the buyer ledger and hold ${sla.holdUsd} USDC until SLA ${sla.slaHours}h.`,
  };
}
