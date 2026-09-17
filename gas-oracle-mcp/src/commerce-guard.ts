/**
 * High-demand A2A SKUs: challenge audit, payment fingerprint, seller unit economics.
 * Pure functions — no keys, no writes.
 */
import { createHash } from "node:crypto";

import { decode402Payload, type Decode402Result } from "./x402-commerce.js";
import { parseUsd } from "./a2a-sku.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const KNOWN_USDC: Record<string, string> = {
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
};

export interface ChallengeAuditResult {
  safeToPay: boolean;
  score: number;
  findings: Array<{ severity: "info" | "warn" | "block"; code: string; detail: string }>;
  decode: Decode402Result;
  cheapestUsd: number | null;
  payToSet: string[];
  auditedAt: string;
}

export function auditX402Challenge(payload: unknown, httpStatus?: number): ChallengeAuditResult {
  const decode = decode402Payload(payload, httpStatus);
  const findings: ChallengeAuditResult["findings"] = [];
  let score = 100;

  if (httpStatus !== undefined && httpStatus !== 402) {
    findings.push({
      severity: "warn",
      code: "HTTP_NOT_402",
      detail: `httpStatus=${httpStatus}; x402 challenges should be 402`,
    });
    score -= 15;
  }

  if (decode.requirementCount === 0) {
    findings.push({
      severity: "block",
      code: "NO_REQUIREMENTS",
      detail: "No payment requirements found in payload",
    });
    score = 0;
  }

  const payToSet = [
    ...new Set(
      decode.requirements.map((r) => (r.payTo || "").toLowerCase()).filter(Boolean),
    ),
  ];

  for (const req of decode.requirements) {
    if (!req.payTo) {
      findings.push({ severity: "block", code: "MISSING_PAYTO", detail: "Requirement missing payTo" });
      score -= 40;
    } else if (req.payTo.toLowerCase() === ZERO) {
      findings.push({ severity: "block", code: "ZERO_PAYTO", detail: "payTo is the zero address" });
      score -= 50;
    }

    if (!req.network) {
      findings.push({ severity: "block", code: "MISSING_NETWORK", detail: "Requirement missing network" });
      score -= 25;
    }

    if (req.maxAmountUsd === null) {
      findings.push({
        severity: "warn",
        code: "UNPARSED_AMOUNT",
        detail: `Could not parse amount ${req.maxAmountRequired}`,
      });
      score -= 10;
    } else if (req.maxAmountUsd > 5) {
      findings.push({
        severity: "warn",
        code: "HIGH_TICKET",
        detail: `Price $${req.maxAmountUsd} is high for a machine micropayment`,
      });
      score -= 8;
    } else if (req.maxAmountUsd === 0) {
      findings.push({ severity: "info", code: "FREE_TIER", detail: "Listed amount is 0" });
    }

    const scheme = (req.scheme || "").toLowerCase();
    if (scheme && scheme !== "exact") {
      findings.push({
        severity: "warn",
        code: "UNUSUAL_SCHEME",
        detail: `scheme=${req.scheme}; most agent rails use exact`,
      });
      score -= 5;
    }

    if (req.network && req.asset) {
      const expected = KNOWN_USDC[req.network.toLowerCase()];
      const asset = req.asset.toLowerCase();
      if (expected && asset.startsWith("0x") && asset !== expected) {
        findings.push({
          severity: "warn",
          code: "UNEXPECTED_ASSET",
          detail: `asset ${req.asset} is not the known USDC for ${req.network}`,
        });
        score -= 12;
      }
    }
  }

  if (payToSet.length > 3) {
    findings.push({
      severity: "warn",
      code: "MANY_PAYEES",
      detail: `${payToSet.length} distinct payTo addresses in one challenge`,
    });
    score -= 8;
  }

  const amounts = decode.requirements
    .map((r) => r.maxAmountUsd)
    .filter((n): n is number => n !== null);
  if (amounts.length >= 2) {
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    if (min > 0 && max / min >= 10) {
      findings.push({
        severity: "warn",
        code: "PRICE_SPREAD",
        detail: `accepts span $${min}–$${max}`,
      });
      score -= 6;
    }
  }

  for (const w of decode.warnings) {
    findings.push({ severity: "info", code: "DECODE_WARNING", detail: w });
  }

  score = Math.max(0, Math.min(100, score));
  const blocked = findings.some((f) => f.severity === "block");
  if (!findings.length) {
    findings.push({
      severity: "info",
      code: "CLEAN",
      detail: "No structural issues in the 402 challenge",
    });
  }

  return {
    safeToPay: !blocked && score >= 55,
    score,
    findings,
    decode,
    cheapestUsd: decode.cheapestUsd,
    payToSet,
    auditedAt: new Date().toISOString(),
  };
}

export function fingerprintPaymentIntent(input: {
  payTo: string;
  network: string;
  amountUsd: unknown;
  resource?: string;
  nonce?: string;
}): { fingerprint: string; components: string[] } {
  const amount = parseUsd(input.amountUsd, "amountUsd").toFixed(6);
  const components = [
    input.payTo.trim().toLowerCase(),
    input.network.trim().toLowerCase(),
    amount,
    (input.resource || "").trim().toLowerCase(),
    (input.nonce || "").trim(),
  ];
  const fingerprint = createHash("sha256").update(components.join("|")).digest("hex");
  return { fingerprint, components };
}

export interface UnitEconomicsInput {
  priceUsd: unknown;
  expectedDailyCalls: number;
  costPerCallUsd?: unknown;
  facilitatorFeeBps?: number;
}

export interface UnitEconomicsResult {
  priceUsd: number;
  expectedDailyCalls: number;
  costPerCallUsd: number;
  facilitatorFeeUsd: number;
  netPerCallUsd: number;
  dailyNetUsd: number;
  monthlyNetUsd: number;
  breakEvenDailyCalls: number;
  viable: boolean;
}

export function estimateSellerUnitEconomics(input: UnitEconomicsInput): UnitEconomicsResult {
  if (!Number.isFinite(input.expectedDailyCalls) || input.expectedDailyCalls < 0) {
    throw new Error("expectedDailyCalls must be a non-negative number");
  }
  const priceUsd = parseUsd(input.priceUsd, "priceUsd");
  const costPerCallUsd = input.costPerCallUsd === undefined ? 0 : parseUsd(input.costPerCallUsd, "costPerCallUsd");
  const bps = input.facilitatorFeeBps ?? 0;
  if (!Number.isFinite(bps) || bps < 0 || bps > 10_000) {
    throw new Error("facilitatorFeeBps must be between 0 and 10000");
  }
  const facilitatorFeeUsd = (priceUsd * bps) / 10_000;
  const netPerCallUsd = priceUsd - costPerCallUsd - facilitatorFeeUsd;
  const dailyNetUsd = netPerCallUsd * input.expectedDailyCalls;
  const monthlyNetUsd = dailyNetUsd * 30;
  const breakEvenDailyCalls = netPerCallUsd <= 0 ? Number.POSITIVE_INFINITY : 0;
  return {
    priceUsd,
    expectedDailyCalls: input.expectedDailyCalls,
    costPerCallUsd,
    facilitatorFeeUsd: Number(facilitatorFeeUsd.toFixed(8)),
    netPerCallUsd: Number(netPerCallUsd.toFixed(8)),
    dailyNetUsd: Number(dailyNetUsd.toFixed(6)),
    monthlyNetUsd: Number(monthlyNetUsd.toFixed(4)),
    breakEvenDailyCalls,
    viable: netPerCallUsd > 0,
  };
}
