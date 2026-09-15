import { normalizeAddress, parseUsd, type FacilitatorCandidate } from "./a2a-sku.js";

/** Canonical USDC addresses agents should settle x402 in. */
export const KNOWN_STABLES: Record<string, { symbol: string; decimals: number; chains: string[] }> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
    symbol: "USDC",
    decimals: 6,
    chains: ["eip155:1"],
  },
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": {
    symbol: "USDC",
    decimals: 6,
    chains: ["eip155:8453"],
  },
  "0x036cbd53842c5426634e7929541ec2318f3d59e2": {
    symbol: "USDC",
    decimals: 6,
    chains: ["eip155:84532"],
  },
};

export interface ScreenAssetInput {
  token: string;
  chainId?: string;
  allowlist?: string[];
  denylist?: string[];
  requireKnownStable?: boolean;
}

export interface ScreenAssetResult {
  allowed: boolean;
  token: string;
  knownStable: boolean;
  symbol: string | null;
  reasons: string[];
  checks: {
    addressValid: boolean;
    onAllowlist: boolean | null;
    onDenylist: boolean;
    knownStable: boolean;
    chainMatch: boolean | null;
  };
  screenedAt: string;
}

export function screenAsset(input: ScreenAssetInput): ScreenAssetResult {
  const reasons: string[] = [];
  let addressValid = true;
  let token = "";
  try {
    token = normalizeAddress(input.token);
  } catch (error) {
    addressValid = false;
    reasons.push(error instanceof Error ? error.message : String(error));
  }

  const allow = (input.allowlist ?? []).map((a) => a.trim().toLowerCase());
  const deny = (input.denylist ?? []).map((a) => a.trim().toLowerCase());
  const onDenylist = Boolean(token && deny.includes(token));
  const onAllowlist = allow.length === 0 ? null : Boolean(token && allow.includes(token));
  const known = token ? KNOWN_STABLES[token] : undefined;
  const knownStable = Boolean(known);
  let chainMatch: boolean | null = null;
  if (known && input.chainId) {
    chainMatch = known.chains.includes(input.chainId);
    if (!chainMatch) reasons.push(`token is not the canonical stable on ${input.chainId}`);
  }

  if (onDenylist) reasons.push("token is on the denylist");
  if (onAllowlist === false) reasons.push("token is not on the allowlist");
  if (input.requireKnownStable && !knownStable) {
    reasons.push("token is not a known USDC-class settlement asset");
  }

  const allowed =
    addressValid &&
    !onDenylist &&
    onAllowlist !== false &&
    chainMatch !== false &&
    !(input.requireKnownStable && !knownStable);

  if (allowed) reasons.push("Asset passed hygiene and optional stablecoin policy.");

  return {
    allowed,
    token: token || input.token,
    knownStable,
    symbol: known?.symbol ?? null,
    reasons,
    checks: { addressValid, onAllowlist, onDenylist, knownStable, chainMatch },
    screenedAt: new Date().toISOString(),
  };
}

export interface SettlementEconomicsInput {
  listedPriceUsd: unknown;
  estimatedGasUsd: unknown;
  facilitatorFeeUsd?: unknown;
  chains?: Array<{ name: string; gasUsd: unknown }>;
}

export interface SettlementEconomicsResult {
  listedPriceUsd: number;
  estimatedGasUsd: number;
  facilitatorFeeUsd: number;
  allInUsd: number;
  cheapestChain: string | null;
  recommendation: string;
  quotedAt: string;
}

export function settlementEconomics(input: SettlementEconomicsInput): SettlementEconomicsResult {
  const listedPriceUsd = parseUsd(input.listedPriceUsd, "listedPriceUsd");
  const estimatedGasUsd = parseUsd(input.estimatedGasUsd, "estimatedGasUsd");
  const facilitatorFeeUsd = parseUsd(input.facilitatorFeeUsd ?? 0, "facilitatorFeeUsd");
  const allInUsd = Number((listedPriceUsd + estimatedGasUsd + facilitatorFeeUsd).toFixed(6));

  let cheapestChain: string | null = null;
  if (input.chains && input.chains.length > 0) {
    const ranked = input.chains
      .map((c) => ({ name: c.name, gasUsd: parseUsd(c.gasUsd, `gasUsd:${c.name}`) }))
      .sort((a, b) => a.gasUsd - b.gasUsd);
    cheapestChain = ranked[0]?.name ?? null;
  }

  const recommendation =
    allInUsd <= 0
      ? "All-in cost is zero — confirm the seller still requires a 402 handshake."
      : cheapestChain
        ? `All-in $${allInUsd.toFixed(6)} USDC. Prefer ${cheapestChain} for gas.`
        : `All-in $${allInUsd.toFixed(6)} USDC including gas and facilitator fee.`;

  return {
    listedPriceUsd,
    estimatedGasUsd,
    facilitatorFeeUsd,
    allInUsd,
    cheapestChain,
    recommendation,
    quotedAt: new Date().toISOString(),
  };
}

const DEFAULT_FACILITATORS = [
  { name: "cdp", url: "https://api.cdp.coinbase.com/platform/v2/x402/supported" },
  { name: "xpay", url: "https://facilitator.xpay.sh/supported" },
];

export type FetchLike = (url: string, init?: { method?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
}>;

export async function probeFacilitatorsLive(
  urls: Array<{ name: string; url: string }> = DEFAULT_FACILITATORS,
  timeoutMs = 2500,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<{
  selected: FacilitatorCandidate | null;
  ranked: FacilitatorCandidate[];
  recommendation: string;
}> {
  const list = urls ?? DEFAULT_FACILITATORS;
  if (!Array.isArray(list) || list.length < 1 || list.length > 8) {
    throw new Error("urls must contain 1-8 facilitator endpoints");
  }

  const probed: FacilitatorCandidate[] = [];
  for (const row of list) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const parsed = new URL(row.url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("only http(s) facilitator URLs are allowed");
      }
      const res = await fetchImpl(row.url, { method: "GET", signal: controller.signal });
      probed.push({
        name: row.name,
        url: row.url,
        ok: res.ok,
        latencyMs: Date.now() - started,
        error: res.ok ? undefined : `HTTP ${res.status}`,
      });
    } catch (error) {
      probed.push({
        name: row.name,
        url: row.url,
        ok: false,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const ranked = [...probed].sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9);
  });
  const selected = ranked.find((row) => row.ok) ?? null;
  return {
    selected,
    ranked,
    recommendation: selected
      ? `Use ${selected.name} (${selected.url}) — live at ${selected.latencyMs}ms.`
      : "No healthy facilitator. Delay settlement and retry.",
  };
}
