import { normalizeAddress, parseUsd, screenPayee } from "./a2a-sku.js";

export interface KnownAsset {
  symbol: string;
  network: string;
  caip2: string;
  address: string;
  decimals: number;
  eip3009: boolean;
}

/** Canonical Circle USDC (not bridged USDbC / PoS USDC.e unless noted). */
export const KNOWN_USDC: KnownAsset[] = [
  {
    symbol: "USDC",
    network: "base",
    caip2: "eip155:8453",
    address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    decimals: 6,
    eip3009: true,
  },
  {
    symbol: "USDC",
    network: "base-sepolia",
    caip2: "eip155:84532",
    address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    decimals: 6,
    eip3009: true,
  },
  {
    symbol: "USDC",
    network: "ethereum",
    caip2: "eip155:1",
    address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6,
    eip3009: true,
  },
  {
    symbol: "USDC",
    network: "arbitrum",
    caip2: "eip155:42161",
    address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    decimals: 6,
    eip3009: true,
  },
  {
    symbol: "USDC",
    network: "optimism",
    caip2: "eip155:10",
    address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
    decimals: 6,
    eip3009: true,
  },
  {
    symbol: "USDC",
    network: "polygon",
    caip2: "eip155:137",
    address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    decimals: 6,
    eip3009: true,
  },
];

export interface ScreenSettlementAssetInput {
  asset: string;
  network?: string;
  caip2?: string;
}

export interface ScreenSettlementAssetResult {
  allowed: boolean;
  asset: string;
  matched: KnownAsset | null;
  reasons: string[];
  screenedAt: string;
}

function looksLikeAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

export function screenSettlementAsset(input: ScreenSettlementAssetInput): ScreenSettlementAssetResult {
  const raw = String(input.asset || "").trim();
  if (!raw) {
    return {
      allowed: false,
      asset: raw,
      matched: null,
      reasons: ["asset is required"],
      screenedAt: new Date().toISOString(),
    };
  }

  const networkHint = (input.network || "").trim().toLowerCase();
  const caip2Hint = (input.caip2 || "").trim().toLowerCase();
  const reasons: string[] = [];

  let matched: KnownAsset | null = null;
  if (looksLikeAddress(raw)) {
    const addr = normalizeAddress(raw);
    matched =
      KNOWN_USDC.find((row) => {
        if (row.address !== addr) return false;
        if (caip2Hint && row.caip2 !== caip2Hint) return false;
        if (networkHint && row.network !== networkHint && row.caip2 !== networkHint) return false;
        return true;
      }) ?? null;
    if (!matched) reasons.push("asset address is not a known native USDC contract for the given network");
  } else {
    const symbol = raw.toUpperCase().replace(/^\$/, "");
    if (symbol !== "USDC") {
      reasons.push(`symbol ${symbol} is not on the settlement allowlist (USDC only)`);
    } else {
      matched =
        KNOWN_USDC.find((row) => {
          if (caip2Hint) return row.caip2 === caip2Hint;
          if (networkHint) return row.network === networkHint || row.caip2 === networkHint;
          return row.network === "base";
        }) ?? null;
      if (!matched) reasons.push("no USDC mapping for the requested network");
    }
  }

  if (matched) reasons.push(`Allow ${matched.symbol} on ${matched.caip2} (${matched.address}).`);

  return {
    allowed: Boolean(matched),
    asset: raw,
    matched,
    reasons,
    screenedAt: new Date().toISOString(),
  };
}

export interface NormalizeX402AmountInput {
  amountUsd: unknown;
  decimals?: number;
  atomic?: string;
}

export interface NormalizeX402AmountResult {
  amountUsd: number;
  decimals: number;
  atomic: string;
  recommendation: string;
}

export function normalizeX402Amount(input: NormalizeX402AmountInput): NormalizeX402AmountResult {
  const decimals = input.decimals === undefined ? 6 : Number(input.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("decimals must be an integer between 0 and 18");
  }

  if (input.atomic !== undefined && input.atomic !== null && String(input.atomic).trim() !== "") {
    const atomic = String(input.atomic).trim();
    if (!/^\d+$/.test(atomic)) throw new Error("atomic must be a non-negative integer string");
    const asUsd = Number(atomic) / 10 ** decimals;
    return {
      amountUsd: Number(asUsd.toFixed(Math.min(6, decimals))),
      decimals,
      atomic,
      recommendation: `402 maxAmountRequired=${atomic} equals $${asUsd.toFixed(6)} at ${decimals} decimals.`,
    };
  }

  const amountUsd = parseUsd(input.amountUsd, "amountUsd");
  const factor = 10 ** decimals;
  const atomicInt = Math.round(amountUsd * factor);
  if (atomicInt < 0) throw new Error("amountUsd must be non-negative");
  return {
    amountUsd,
    decimals,
    atomic: String(atomicInt),
    recommendation: `Set maxAmountRequired to ${atomicInt} (${decimals} decimals) for $${amountUsd.toFixed(6)}.`,
  };
}

export interface SettlementReadinessInput {
  payTo: string;
  asset: string;
  amountUsd?: unknown;
  atomic?: string;
  network?: string;
  caip2?: string;
  allowlist?: string[];
  denylist?: string[];
  maxPriceUsd?: unknown;
}

export function settlementReadiness(input: SettlementReadinessInput) {
  const asset = screenSettlementAsset({
    asset: input.asset,
    network: input.network,
    caip2: input.caip2,
  });
  const decimals = asset.matched?.decimals ?? 6;
  const amount = normalizeX402Amount({
    amountUsd: input.amountUsd ?? 0,
    atomic: input.atomic,
    decimals,
  });
  const payee = screenPayee({
    payTo: input.payTo,
    allowlist: input.allowlist,
    denylist: input.denylist,
    listedPriceUsd: amount.amountUsd,
    maxPriceUsd: input.maxPriceUsd,
  });
  const ready = asset.allowed && payee.allowed && amount.atomic !== "0";
  return {
    ready,
    asset,
    amount,
    payee,
    recommendation: ready
      ? `Safe to sign exact USDC on ${asset.matched?.caip2 ?? "unknown"} to ${payee.payTo} for ${amount.atomic} atomic units.`
      : "Do not sign. Fix asset, payee, or amount first.",
    checkedAt: new Date().toISOString(),
  };
}
