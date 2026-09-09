/**
 * High-demand A2A SKUs: seller risk scoring + pay-session preflight.
 *
 * Buyer agents loop these before every x402 spend. They never sign, never
 * hold keys, and never execute payments — decision data only.
 */
import { planAgentSpend } from "./agent-commerce.js";
import { decode402Payload, type Decode402Result } from "./x402-commerce.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const KNOWN_NETWORKS = new Set([
  "eip155:8453",
  "eip155:84532",
  "eip155:1",
  "eip155:42161",
  "eip155:10",
  "eip155:137",
  "base",
  "base-sepolia",
  "ethereum",
  "arbitrum",
  "optimism",
  "polygon",
  "solana",
  "solana:mainnet",
]);

export interface SellerScoreResult {
  score: number;
  band: "low" | "medium" | "high" | "critical";
  flags: string[];
  decode: Decode402Result;
  recommendation: string;
  scoredAt: string;
}

function isHexAddress(value: string | null): boolean {
  return Boolean(value && /^0x[a-fA-F0-9]{40}$/.test(value));
}

export function scoreX402Seller(payload: unknown, httpStatus?: number): SellerScoreResult {
  const decode = decode402Payload(payload, httpStatus);
  const flags: string[] = [];
  let score = 15;

  if (!decode.paymentRequired) {
    flags.push("no_payment_required");
    score += 10;
  }
  if (decode.requirementCount === 0) {
    flags.push("empty_accepts");
    score += 35;
  }
  if (decode.warnings.length) {
    flags.push("decode_warnings");
    score += 10;
  }

  for (const req of decode.requirements) {
    if (!req.scheme) {
      flags.push("missing_scheme");
      score += 8;
    } else if (!["exact", "upto", "uptoExact", "batch-settlement"].includes(req.scheme)) {
      flags.push(`unusual_scheme:${req.scheme}`);
      score += 12;
    }

    if (!req.network) {
      flags.push("missing_network");
      score += 15;
    } else if (!KNOWN_NETWORKS.has(req.network.toLowerCase()) && !KNOWN_NETWORKS.has(req.network)) {
      flags.push(`unknown_network:${req.network}`);
      score += 18;
    }

    if (!req.payTo) {
      flags.push("missing_payTo");
      score += 25;
    } else if (!isHexAddress(req.payTo) && !req.payTo.startsWith("0x") && req.network?.includes("eip155")) {
      flags.push("payTo_not_evm_address");
      score += 20;
    } else if (req.payTo.toLowerCase() === ZERO_ADDRESS) {
      flags.push("payTo_zero_address");
      score += 40;
    }

    if (req.maxAmountUsd == null) {
      flags.push("unreadable_price");
      score += 20;
    } else if (req.maxAmountUsd > 25) {
      flags.push("high_ticket");
      score += 25;
    } else if (req.maxAmountUsd > 5) {
      flags.push("elevated_price");
      score += 10;
    } else if (req.maxAmountUsd < 0.0001) {
      flags.push("dust_price_possible_probe");
      score += 4;
    }

    const asset = (req.asset || "").toUpperCase();
    if (asset && !["USDC", "EURC", "USD", "USDBC"].includes(asset) && !asset.includes("USDC")) {
      flags.push(`non_stable_asset:${req.asset}`);
      score += 15;
    }
  }

  score = Math.max(0, Math.min(100, score));
  const band: SellerScoreResult["band"] =
    score >= 80 ? "critical" : score >= 55 ? "high" : score >= 30 ? "medium" : "low";

  const recommendation =
    band === "critical"
      ? "Do not pay. Seller challenge failed basic safety checks."
      : band === "high"
        ? "Hold. Inspect payTo, network, and price before any USDC leaves the wallet."
        : band === "medium"
          ? "Pay only if wallet policy allows this network and amount."
          : "Looks like a standard x402 challenge. Still enforce spend limits.";

  return {
    score,
    band,
    flags: [...new Set(flags)],
    decode,
    recommendation,
    scoredAt: new Date().toISOString(),
  };
}

export interface PreflightPaySessionInput {
  balanceUsd: unknown;
  payload: unknown;
  httpStatus?: number;
  reserveUsd?: unknown;
  maxCalls?: unknown;
}

export interface PreflightPaySessionResult {
  canPay: boolean;
  seller: SellerScoreResult;
  spend: ReturnType<typeof planAgentSpend>;
  priceUsd: number | null;
  blockers: string[];
  nextAction: string;
  preflightAt: string;
}

export function preflightPaySession(input: PreflightPaySessionInput): PreflightPaySessionResult {
  const seller = scoreX402Seller(input.payload, input.httpStatus);
  const priceUsd = seller.decode.cheapestUsd;
  const blockers: string[] = [];

  if (seller.band === "critical") blockers.push("seller_score_critical");
  if (priceUsd == null) blockers.push("price_unreadable");

  const spend = planAgentSpend({
    balanceUsd: input.balanceUsd,
    pricePerCallUsd: priceUsd != null && priceUsd > 0 ? priceUsd : 1,
    reserveUsd: input.reserveUsd,
    maxCalls: input.maxCalls ?? 1,
  });

  if (!spend.canAffordAtLeastOne) blockers.push("insufficient_balance");

  const canPay = blockers.length === 0 && seller.band !== "high";
  const nextAction = canPay
    ? `Safe to attempt 1 call at ≈ $${priceUsd}. Keep reserve $${spend.reserveUsd}.`
    : blockers.includes("seller_score_critical")
      ? "Abort. Do not attach a payment header."
      : blockers.includes("insufficient_balance")
        ? spend.recommendation
        : seller.recommendation;

  return {
    canPay,
    seller,
    spend,
    priceUsd,
    blockers,
    nextAction,
    preflightAt: new Date().toISOString(),
  };
}
