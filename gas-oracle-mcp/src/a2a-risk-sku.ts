import { parseUsd } from "./a2a-sku.js";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX_RE = /^0x[a-fA-F0-9]*$/;

export interface TokenRiskInput {
  token: string;
  symbol?: string;
  decimals?: unknown;
  bytecodeHex?: string;
  totalSupplyHint?: unknown;
}

export interface TokenRiskFinding {
  code: string;
  severity: "info" | "warn" | "high";
  detail: string;
}

export interface TokenRiskResult {
  token: string;
  riskScore: number;
  recommendation: "allow" | "verify" | "reject";
  findings: TokenRiskFinding[];
  selectors: string[];
  screenedAt: string;
}

function normalizeToken(token: string): string {
  const trimmed = token.trim();
  if (!ADDRESS_RE.test(trimmed)) {
    throw new Error("token must be a 20-byte 0x-prefixed EVM address");
  }
  return trimmed.toLowerCase();
}

function extractSelectors(bytecodeHex: string): string[] {
  const hex = bytecodeHex.toLowerCase().replace(/^0x/, "");
  const found = new Set<string>();
  for (let i = 0; i + 8 <= hex.length; i += 2) {
    const chunk = hex.slice(i, i + 8);
    if (chunk.startsWith("63") && i + 10 <= hex.length) {
      found.add("0x" + hex.slice(i + 2, i + 10));
    }
  }
  return [...found].slice(0, 64);
}

export function analyzeTokenRisk(input: TokenRiskInput): TokenRiskResult {
  const token = normalizeToken(input.token);
  const findings: TokenRiskFinding[] = [];
  const symbol = String(input.symbol || "").trim();
  const decimals = input.decimals === undefined ? null : Number(input.decimals);
  const bytecode = String(input.bytecodeHex || "").trim();

  if (decimals !== null && (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)) {
    findings.push({ code: "odd_decimals", severity: "warn", detail: "decimals outside 0-18" });
  }
  if (decimals === 6 || decimals === 18) {
    findings.push({ code: "standard_decimals", severity: "info", detail: `decimals=${decimals}` });
  }

  if (symbol && /usd[ct]|usdc|dai|eurc/i.test(symbol) && token !== "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") {
    findings.push({
      code: "stable_name_spoof",
      severity: "high",
      detail: "symbol looks like a major stablecoin but address is not Base USDC",
    });
  }

  let selectors: string[] = [];
  if (bytecode) {
    if (!HEX_RE.test(bytecode) || bytecode.length < 10) {
      findings.push({ code: "bad_bytecode", severity: "warn", detail: "bytecodeHex is not valid hex" });
    } else {
      const raw = bytecode.toLowerCase();
      selectors = extractSelectors(raw);
      if (raw.includes("ff")) {
        findings.push({
          code: "ff_byte_present",
          severity: "info",
          detail: "0xff bytes present; treat as a hint only, not proof of SELFDESTRUCT",
        });
      }
      if (raw.includes("f4")) {
        findings.push({
          code: "delegatecall_present",
          severity: "warn",
          detail: "DELEGATECALL (0xf4) present — proxy/upgrade risk for settlement tokens",
        });
      }
      const hasTransfer = selectors.includes("0xa9059cbb") || raw.includes("a9059cbb");
      const hasTransferFrom = selectors.includes("0x23b872dd") || raw.includes("23b872dd");
      if (!hasTransfer || !hasTransferFrom) {
        findings.push({
          code: "missing_erc20_selectors",
          severity: "high",
          detail: "missing transfer and/or transferFrom selector — not a usable pay asset",
        });
      }
      if (raw.includes("9dc29fac") || raw.includes("40c10f19")) {
        findings.push({
          code: "mint_burn",
          severity: "warn",
          detail: "mint/burn selectors present — supply can change after quote",
        });
      }
    }
  } else {
    findings.push({
      code: "no_bytecode",
      severity: "info",
      detail: "no bytecode supplied; analysis is metadata-only",
    });
  }

  const high = findings.filter((f) => f.severity === "high").length;
  const warn = findings.filter((f) => f.severity === "warn").length;
  const riskScore = Math.min(100, high * 40 + warn * 15);
  const recommendation: TokenRiskResult["recommendation"] =
    high > 0 ? "reject" : warn > 1 ? "verify" : "allow";

  return {
    token,
    riskScore,
    recommendation,
    findings,
    selectors,
    screenedAt: new Date().toISOString(),
  };
}

export type SettleOutcome = "settled" | "pending" | "failed" | "invalid";

export interface FacilitatorSettleBody {
  success?: unknown;
  transaction?: unknown;
  errorReason?: unknown;
  txHash?: unknown;
}

export interface SettlePollResult {
  outcome: SettleOutcome;
  shouldPollAgain: boolean;
  transaction: string;
  reason: string;
  polledAt: string;
}

export function classifyFacilitatorSettle(body: FacilitatorSettleBody, protocol: "v1" | "v2" = "v2"): SettlePollResult {
  const success = body.success === true;
  const transaction = String(body.transaction ?? body.txHash ?? "").trim();
  const errorReason = String(body.errorReason ?? "").trim();
  const polledAt = new Date().toISOString();

  if (success) {
    return { outcome: "settled", shouldPollAgain: false, transaction, reason: "facilitator reported success", polledAt };
  }

  if (protocol === "v2") {
    if (transaction) {
      return {
        outcome: "pending",
        shouldPollAgain: true,
        transaction,
        reason: "V2 success=false with tx hash is in-flight; poll until settled or deadline",
        polledAt,
      };
    }
    return {
      outcome: "failed",
      shouldPollAgain: false,
      transaction: "",
      reason: "V2 empty transaction is a terminal failure",
      polledAt,
    };
  }

  if (errorReason && errorReason !== "settle_exact_evm_transaction_confirmation_timed_out") {
    return { outcome: "failed", shouldPollAgain: false, transaction, reason: errorReason, polledAt };
  }
  if (transaction || errorReason === "settle_exact_evm_transaction_confirmation_timed_out") {
    return {
      outcome: "pending",
      shouldPollAgain: true,
      transaction,
      reason: "V1 confirmation timeout or hash present — keep polling idempotently",
      polledAt,
    };
  }
  return { outcome: "invalid", shouldPollAgain: false, transaction: "", reason: "unrecognized settle body", polledAt };
}

export async function pollFacilitatorSettle(input: {
  facilitatorUrl: string;
  body?: unknown;
  protocol?: "v1" | "v2";
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<SettlePollResult & { httpStatus: number | null; facilitatorUrl: string }> {
  const url = String(input.facilitatorUrl || "").trim();
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("facilitatorUrl must be https");
  }
  const timeoutMs = input.timeoutMs ?? 2500;
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let httpStatus: number | null = null;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.body ?? {}),
      signal: controller.signal,
      redirect: "manual",
    });
    httpStatus = res.status;
    const json = (await res.json().catch(() => ({}))) as FacilitatorSettleBody;
    return { ...classifyFacilitatorSettle(json, input.protocol ?? "v2"), httpStatus, facilitatorUrl: url };
  } finally {
    clearTimeout(timer);
  }
}

export interface OnchainSlaPlanInput {
  buyer: string;
  seller: string;
  token: string;
  serviceUsd: unknown;
  slaHours: unknown;
  penaltyBps?: unknown;
}

export interface OnchainSlaPlan {
  buyer: string;
  seller: string;
  token: string;
  serviceUsd: number;
  slaSeconds: number;
  penaltyBps: number;
  holdUsd: number;
  recommendedPattern: string;
  deployAdvice: string[];
  quotedAt: string;
}

export function planOnchainSlaEscrow(input: OnchainSlaPlanInput): OnchainSlaPlan {
  const buyer = normalizeToken(input.buyer);
  const seller = normalizeToken(input.seller);
  const token = normalizeToken(input.token);
  if (buyer === seller) throw new Error("buyer and seller must differ");
  const quote = {
    serviceUsd: parseUsd(input.serviceUsd, "serviceUsd"),
    slaHours: Number(input.slaHours),
    penaltyBps: input.penaltyBps === undefined ? 500 : Number(input.penaltyBps),
  };
  if (!Number.isFinite(quote.slaHours) || quote.slaHours < 0.25 || quote.slaHours > 168) {
    throw new Error("slaHours must be between 0.25 and 168");
  }
  if (!Number.isInteger(quote.penaltyBps) || quote.penaltyBps < 0 || quote.penaltyBps > 10_000) {
    throw new Error("penaltyBps must be an integer between 0 and 10000");
  }
  return {
    buyer,
    seller,
    token,
    serviceUsd: quote.serviceUsd,
    slaSeconds: Math.round(quote.slaHours * 3600),
    penaltyBps: quote.penaltyBps,
    holdUsd: Number((quote.serviceUsd * 1.25).toFixed(6)),
    recommendedPattern: "pull-payment escrow with receipt hash + timeout slash, not push-payment custom bytecode",
    deployAdvice: [
      "Do not deploy unaudited escrow from this planner; it only sizes parameters.",
      "Settle the commercial hold off-chain first via quote_sla_escrow + issue_delivery_receipt.",
      "If you later deploy on-chain, use a reviewed pull-payment escrow and USDC on Base.",
      "Pair with screen_token and analyze_token_risk before approving the hold asset.",
    ],
    quotedAt: new Date().toISOString(),
  };
}
