import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  issueDeliveryReceipt,
  parseUsd,
  quoteSlaEscrow,
  verifyDeliveryReceipt,
  type DeliveryReceipt,
} from "./a2a-sku.js";

function packSecret(): string {
  return (
    process.env.SPEND_SESSION_HMAC_SECRET?.trim() ||
    process.env.RECEIPT_HMAC_SECRET?.trim() ||
    process.env.MCP_API_KEY?.trim() ||
    "dev-spend-session-secret"
  );
}

function sign(canonical: string): string {
  return createHmac("sha256", packSecret()).update(canonical).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export interface SpendSession {
  sessionId: string;
  parentAgent: string;
  budgetUsd: string;
  spentUsd: string;
  remainingUsd: string;
  allowSkus: string[];
  expiresAt: string;
  signature: string;
}

function canonicalSession(parts: Omit<SpendSession, "signature">): string {
  return [
    parts.sessionId,
    parts.parentAgent,
    parts.budgetUsd,
    parts.spentUsd,
    parts.remainingUsd,
    parts.allowSkus.join(","),
    parts.expiresAt,
  ].join("|");
}

export function issueSpendSession(input: {
  parentAgent: string;
  budgetUsd: unknown;
  ttlSeconds?: unknown;
  allowSkus?: string[];
}): SpendSession {
  const parentAgent = String(input.parentAgent || "").trim();
  if (!parentAgent) throw new Error("parentAgent is required");
  const budget = parseUsd(input.budgetUsd, "budgetUsd");
  if (budget <= 0) throw new Error("budgetUsd must be greater than 0");
  const ttlRaw = input.ttlSeconds === undefined ? 3600 : Number(input.ttlSeconds);
  if (!Number.isInteger(ttlRaw) || ttlRaw < 60 || ttlRaw > 86_400) {
    throw new Error("ttlSeconds must be an integer between 60 and 86400");
  }
  const allowSkus = (input.allowSkus ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 40);
  const issued = Date.now();
  const unsigned: Omit<SpendSession, "signature"> = {
    sessionId: randomBytes(16).toString("hex"),
    parentAgent,
    budgetUsd: budget.toFixed(6),
    spentUsd: (0).toFixed(6),
    remainingUsd: budget.toFixed(6),
    allowSkus,
    expiresAt: new Date(issued + ttlRaw * 1000).toISOString(),
  };
  return { ...unsigned, signature: sign(canonicalSession(unsigned)) };
}

export function consumeSpendSession(input: {
  session: SpendSession;
  sku: string;
  amountUsd: unknown;
  now?: Date;
}): { allowed: boolean; reason: string; session: SpendSession } {
  const expected = sign(
    canonicalSession({
      sessionId: input.session.sessionId,
      parentAgent: input.session.parentAgent,
      budgetUsd: input.session.budgetUsd,
      spentUsd: input.session.spentUsd,
      remainingUsd: input.session.remainingUsd,
      allowSkus: input.session.allowSkus,
      expiresAt: input.session.expiresAt,
    }),
  );
  if (!safeEqual(expected, String(input.session.signature || ""))) {
    return { allowed: false, reason: "session signature invalid", session: input.session };
  }
  const now = input.now ?? new Date();
  if (Date.parse(input.session.expiresAt) <= now.getTime()) {
    return { allowed: false, reason: "session expired", session: input.session };
  }
  const sku = String(input.sku || "").trim();
  if (!sku) throw new Error("sku is required");
  if (input.session.allowSkus.length > 0 && !input.session.allowSkus.includes(sku)) {
    return { allowed: false, reason: `sku ${sku} is not on the session allowlist`, session: input.session };
  }
  const amount = parseUsd(input.amountUsd, "amountUsd");
  const remaining = parseUsd(input.session.remainingUsd, "remainingUsd");
  if (amount > remaining) {
    return { allowed: false, reason: `amount ${amount} exceeds remaining ${remaining}`, session: input.session };
  }
  const spent = Number((parseUsd(input.session.spentUsd, "spentUsd") + amount).toFixed(6));
  const nextRemaining = Number((remaining - amount).toFixed(6));
  const nextUnsigned: Omit<SpendSession, "signature"> = {
    sessionId: input.session.sessionId,
    parentAgent: input.session.parentAgent,
    budgetUsd: input.session.budgetUsd,
    spentUsd: spent.toFixed(6),
    remainingUsd: nextRemaining.toFixed(6),
    allowSkus: input.session.allowSkus,
    expiresAt: input.session.expiresAt,
  };
  return {
    allowed: true,
    reason: `Debited ${amount.toFixed(6)} USDC from child-agent session.`,
    session: { ...nextUnsigned, signature: sign(canonicalSession(nextUnsigned)) },
  };
}

export interface HostDossierInput {
  host: string;
  l30DaysTotalCalls?: unknown;
  l30DaysUniquePayers?: unknown;
  listedPriceUsd?: unknown;
  scheme?: string;
  isNew?: boolean;
  headerHygieneOk?: boolean;
}

export interface HostDossierResult {
  host: string;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  reasons: string[];
  buy: boolean;
  scoredAt: string;
}

export function sellerHostDossier(input: HostDossierInput): HostDossierResult {
  const host = String(input.host || "").trim().toLowerCase();
  if (!host || host.length > 253) throw new Error("host is required");
  const calls = Number(input.l30DaysTotalCalls ?? 0);
  const payers = Number(input.l30DaysUniquePayers ?? 0);
  if (!Number.isFinite(calls) || calls < 0 || !Number.isFinite(payers) || payers < 0) {
    throw new Error("call and payer counts must be non-negative numbers");
  }
  const reasons: string[] = [];
  let score = 40;
  if (payers >= 30) {
    score += 25;
    reasons.push("healthy unique-payer base");
  } else if (payers >= 8) {
    score += 12;
    reasons.push("some organic payers");
  } else {
    score -= 10;
    reasons.push("thin unique-payer base — treat volume as possibly self-deal");
  }
  if (calls >= 1000) score += 15;
  else if (calls >= 50) score += 6;
  if (input.headerHygieneOk) {
    score += 10;
    reasons.push("402 header hygiene reported ok");
  } else if (input.headerHygieneOk === false) {
    score -= 20;
    reasons.push("402 header hygiene failed");
  }
  if (input.scheme === "exact" || input.scheme === "upto") {
    score += 5;
    reasons.push(`scheme ${input.scheme} is first-class x402`);
  }
  if (input.isNew) {
    score -= 5;
    reasons.push("new listing — demand extra receipts");
  }
  if (input.listedPriceUsd !== undefined) {
    const price = parseUsd(input.listedPriceUsd, "listedPriceUsd");
    if (price > 1) {
      score -= 8;
      reasons.push("ticket above typical agent loop ($1)");
    } else if (price > 0 && price <= 0.05) {
      score += 5;
      reasons.push("micropayment-priced for inner loops");
    }
  }
  score = Math.max(0, Math.min(100, score));
  const grade: HostDossierResult["grade"] =
    score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : score >= 35 ? "D" : "F";
  const buy = score >= 50 && input.headerHygieneOk !== false;
  if (buy) reasons.push("Buy only with settlement verify + delivery receipt.");
  else reasons.push("Do not auto-pay this host without extra screens.");
  return { host, score, grade, reasons, buy, scoredAt: new Date().toISOString() };
}

export function quoteReceiptSlaPack(input: {
  sku: string;
  buyer: string;
  seller: string;
  amountUsd: unknown;
  contentHash: string;
  slaHours: unknown;
  penaltyBps?: unknown;
}): {
  receipt: DeliveryReceipt;
  receiptCheck: { valid: boolean; reason: string };
  sla: ReturnType<typeof quoteSlaEscrow>;
  packPriceHintUsd: number;
  recommendation: string;
} {
  const receipt = issueDeliveryReceipt({
    sku: input.sku,
    buyer: input.buyer,
    seller: input.seller,
    amountUsd: input.amountUsd,
    contentHash: input.contentHash,
  });
  const receiptCheck = verifyDeliveryReceipt(receipt);
  const sla = quoteSlaEscrow({
    serviceUsd: input.amountUsd,
    slaHours: input.slaHours,
    penaltyBps: input.penaltyBps,
  });
  return {
    receipt,
    receiptCheck,
    sla,
    packPriceHintUsd: 0.02,
    recommendation: receiptCheck.valid
      ? "Pack is internally consistent. Use as a single paid hop after settlement verify."
      : "Receipt failed self-check — refuse pack.",
  };
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype", "eval", "function", "script"]);

export function validateSellerPayload(input: {
  payload: unknown;
  requiredKeys?: string[];
  maxBytes?: number;
}): {
  ok: boolean;
  reasons: string[];
  redactedKeys: string[];
  byteLength: number;
} {
  const reasons: string[] = [];
  const redactedKeys: string[] = [];
  const raw = JSON.stringify(input.payload ?? null);
  const byteLength = Buffer.byteLength(raw, "utf8");
  const maxBytes = input.maxBytes === undefined ? 16_384 : Number(input.maxBytes);
  if (!Number.isInteger(maxBytes) || maxBytes < 32 || maxBytes > 65_536) {
    throw new Error("maxBytes must be an integer between 32 and 65536");
  }
  if (byteLength > maxBytes) {
    reasons.push(`payload ${byteLength} bytes exceeds cap ${maxBytes}`);
  }
  const walk = (value: unknown, path: string) => {
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const next = path ? `${path}.${key}` : key;
        if (DANGEROUS_KEYS.has(key.toLowerCase())) {
          redactedKeys.push(next);
          reasons.push(`dangerous key ${next}`);
        }
        walk(child, next);
      }
    } else if (typeof value === "string" && /<\/?script|javascript:/i.test(value)) {
      reasons.push(`script-like string at ${path || "root"}`);
    }
  };
  walk(input.payload, "");
  for (const key of input.requiredKeys ?? []) {
    if (input.payload === null || typeof input.payload !== "object" || !(key in (input.payload as object))) {
      reasons.push(`missing required key ${key}`);
    }
  }
  return {
    ok: reasons.length === 0,
    reasons: reasons.length ? reasons : ["payload passed size, key, and script-string checks"],
    redactedKeys,
    byteLength,
  };
}
