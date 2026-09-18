/**
 * True-cost ranking for agent-to-agent x402 shopping.
 *
 * Listed USDC price is not what the buyer spends. Facilitator settlement,
 * L1 vs L2 gas, and failed retries change the all-in cost. This module
 * is pure (no network) so agents can rank quotes before they sign.
 */

const USDC_PRICE_RE = /^\$?(0|[1-9]\d*)(\.\d{1,8})?$/;

export function parseUsdAmount(raw: unknown, label = "amount"): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim().replace(/^\$/, "");
    if (USDC_PRICE_RE.test(trimmed)) return Number(trimmed);
    const n = Number(trimmed);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  throw new Error(`${label} must be a non-negative USD amount`);
}

/** Conservative USDC overhead for one successful x402 settlement on a rail. */
export const SETTLEMENT_OVERHEAD_USD: Record<string, number> = {
  "eip155:8453": 0.0002,
  base: 0.0002,
  "eip155:84532": 0.00005,
  "base-sepolia": 0.00005,
  "eip155:1": 0.12,
  ethereum: 0.12,
  "eip155:42161": 0.0004,
  arbitrum: 0.0004,
  "eip155:10": 0.0004,
  optimism: 0.0004,
  "eip155:137": 0.0008,
  polygon: 0.0008,
  "solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp": 0.00015,
  solana: 0.00015,
};

export const DEFAULT_SETTLEMENT_OVERHEAD_USD = 0.002;

export function normalizeNetwork(network: string): string {
  return network.trim().toLowerCase();
}

export function settlementOverheadUsd(network: string): number {
  const key = normalizeNetwork(network);
  return SETTLEMENT_OVERHEAD_USD[key] ?? DEFAULT_SETTLEMENT_OVERHEAD_USD;
}

export interface ShopListing {
  id?: string;
  name: string;
  url?: string;
  network: string;
  listedUsd: unknown;
  expectedRetries?: unknown;
  uniquePayers30d?: unknown;
  calls30d?: unknown;
}

export interface RankedShopRow {
  id?: string;
  name: string;
  url?: string;
  network: string;
  listedUsd: number;
  settlementOverheadUsd: number;
  expectedRetries: number;
  trueCostUsd: number;
  demandScore: number;
  recommendation: string;
}

export interface TrueCostShopResult {
  ranked: RankedShopRow[];
  cheapest: RankedShopRow | null;
  bestValue: RankedShopRow | null;
  recommendation: string;
  rankedAt: string;
}

function clampRetries(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error("expectedRetries must be >= 1");
  }
  if (n > 5) {
    throw new Error("expectedRetries must be <= 5");
  }
  return n;
}

function demandScore(payers: unknown, calls: unknown): number {
  const p = Number(payers) || 0;
  const c = Number(calls) || 0;
  if (p < 0 || c < 0) return 0;
  return Number((Math.log10(1 + p) * 2 + Math.log10(1 + c)).toFixed(4));
}

export function rankTrueCostShop(listings: ShopListing[]): TrueCostShopResult {
  if (!Array.isArray(listings) || listings.length < 1 || listings.length > 25) {
    throw new Error("listings must contain 1-25 seller quotes");
  }

  const ranked: RankedShopRow[] = listings.map((row, index) => {
    const name = String(row.name || "").trim() || `listing-${index + 1}`;
    const network = String(row.network || "").trim();
    if (!network) throw new Error(`listings[${index}].network is required`);
    const listedUsd = parseUsdAmount(row.listedUsd, `listings[${index}].listedUsd`);
    const expectedRetries = clampRetries(row.expectedRetries);
    const overhead = settlementOverheadUsd(network);
    const trueCostUsd = Number((listedUsd * expectedRetries + overhead).toFixed(8));
    const demand = demandScore(row.uniquePayers30d, row.calls30d);
    return {
      id: row.id,
      name,
      url: row.url,
      network,
      listedUsd,
      settlementOverheadUsd: overhead,
      expectedRetries,
      trueCostUsd,
      demandScore: demand,
      recommendation:
        listedUsd === 0
          ? "Listed free — still budget settlement overhead before signing."
          : `All-in ~$${trueCostUsd.toFixed(6)} USDC on ${network}.`,
    };
  });

  ranked.sort((a, b) => {
    if (a.trueCostUsd !== b.trueCostUsd) return a.trueCostUsd - b.trueCostUsd;
    return b.demandScore - a.demandScore;
  });

  const cheapest = ranked[0] ?? null;
  const bestValue =
    [...ranked].sort((a, b) => {
      const aScore = a.demandScore / Math.max(a.trueCostUsd, 0.000001);
      const bScore = b.demandScore / Math.max(b.trueCostUsd, 0.000001);
      return bScore - aScore;
    })[0] ?? null;

  return {
    ranked,
    cheapest,
    bestValue,
    recommendation: cheapest
      ? `Buy ${cheapest.name} first (true cost $${cheapest.trueCostUsd.toFixed(6)}). Best demand/price is ${bestValue?.name}.`
      : "No listings to rank.",
    rankedAt: new Date().toISOString(),
  };
}

export interface ShopBudgetPlan {
  balanceUsd: number;
  reserveUsd: number;
  spendableUsd: number;
  cheapestTrueCostUsd: number | null;
  maxCalls: number;
  recommendation: string;
}

export function planShopBudget(input: {
  balanceUsd: unknown;
  reserveUsd?: unknown;
  cheapestTrueCostUsd?: unknown;
}): ShopBudgetPlan {
  const balanceUsd = parseUsdAmount(input.balanceUsd, "balanceUsd");
  const reserveUsd = parseUsdAmount(input.reserveUsd ?? 0, "reserveUsd");
  if (reserveUsd > balanceUsd) {
    throw new Error("reserveUsd cannot exceed balanceUsd");
  }
  const spendableUsd = Number((balanceUsd - reserveUsd).toFixed(8));
  const cheapest =
    input.cheapestTrueCostUsd === undefined || input.cheapestTrueCostUsd === null
      ? null
      : parseUsdAmount(input.cheapestTrueCostUsd, "cheapestTrueCostUsd");
  const maxCalls = cheapest && cheapest > 0 ? Math.floor(spendableUsd / cheapest) : 0;
  return {
    balanceUsd,
    reserveUsd,
    spendableUsd,
    cheapestTrueCostUsd: cheapest,
    maxCalls,
    recommendation:
      cheapest === null
        ? `Keep $${reserveUsd.toFixed(6)} in reserve. $${spendableUsd.toFixed(6)} is spendable.`
        : maxCalls < 1
          ? `Cannot afford the cheapest listing ($${cheapest.toFixed(6)}) after reserve.`
          : `Afford ${maxCalls} call(s) at $${cheapest.toFixed(6)} true cost with $${reserveUsd.toFixed(6)} reserved.`,
  };
}
