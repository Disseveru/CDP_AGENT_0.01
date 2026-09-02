/**
 * Buyer-side x402 commerce helpers for AgentWire 1.6.
 */
import { isAddress, type Address } from "viem";

import { assertSafePublicUrl } from "./http-safety.js";
import { getBalance, getGasOracle } from "./gas.js";

const FETCH_TIMEOUT_MS = 8_000;
const MARKET_API = "https://api.agentic.market/v1/services/search";

const USDC_BY_NETWORK: Record<string, Address> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
};

function parseAddress(raw: unknown, label = "address"): Address {
  const value = String(raw || "").trim();
  if (!isAddress(value)) {
    throw new Error(`Invalid ${label}: "${raw}"`);
  }
  return value as Address;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "follow",
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": "AgentWire/1.6 (+x402)",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function decodePaymentRequiredHeader(header: string | null): unknown {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    try {
      return JSON.parse(header);
    } catch {
      return header.slice(0, 500);
    }
  }
}

export async function probeX402Endpoint(input: { url: unknown; method?: unknown }) {
  const parsed = await assertSafePublicUrl(String(input.url || ""));
  const method = String(input.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "POST"].includes(method)) {
    throw new Error("method must be GET, HEAD, or POST");
  }
  const started = Date.now();
  const response = await fetchWithTimeout(parsed.toString(), {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : undefined,
    body: method === "POST" ? "{}" : undefined,
  });
  const header =
    response.headers.get("PAYMENT-REQUIRED") ||
    response.headers.get("payment-required") ||
    response.headers.get("X-Payment-Required");
  let bodyPreview: unknown = null;
  if (method !== "HEAD") {
    const text = await response.text();
    try {
      bodyPreview = JSON.parse(text);
    } catch {
      bodyPreview = text.slice(0, 800);
    }
  }
  const paymentRequired = response.status === 402 || Boolean(header);
  const recommendation = paymentRequired
    ? "Endpoint advertises x402. Inspect accepts/amount before signing PAYMENT-SIGNATURE."
    : response.status >= 200 && response.status < 300
      ? "Endpoint responded 2xx without a 402. It may be free or not an x402 seller."
      : `Endpoint is not a clean x402 seller (HTTP ${response.status}). Do not pay blindly.`;
  return {
    url: parsed.toString(),
    method,
    httpStatus: response.status,
    paymentRequired,
    paymentRequiredHeader: decodePaymentRequiredHeader(header),
    bodyPreview,
    recommendation,
    probedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
  };
}

function toNumber(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export async function rankAgenticSellers(input: { query: unknown; limit?: unknown }) {
  const query = String(input.query || "").trim();
  if (query.length < 2 || query.length > 80) {
    throw new Error("query must be 2-80 characters");
  }
  const limitRaw = input.limit === undefined ? 8 : Number(input.limit);
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 15) {
    throw new Error("limit must be an integer between 1 and 15");
  }
  const response = await fetchWithTimeout(`${MARKET_API}?q=${encodeURIComponent(query)}`);
  if (!response.ok) {
    throw new Error(`Agentic.Market search failed: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { services?: Array<Record<string, unknown>> };
  const services = Array.isArray(payload.services) ? payload.services : [];
  const sellers = services.slice(0, limitRaw).map((svc) => {
    const endpointsRaw = Array.isArray(svc.endpoints) ? svc.endpoints : [];
    const endpoints = endpointsRaw.slice(0, 6).map((ep) => {
      const row = ep as Record<string, unknown>;
      const pricing = (row.pricing || {}) as Record<string, unknown>;
      return {
        url: String(row.url || ""),
        method: String(row.method || "GET"),
        amount: String(pricing.amount || ""),
        description: String(row.description || ""),
      };
    });
    const qualityRollup = endpointsRaw.reduce(
      (acc, ep) => {
        const quality = ((ep as Record<string, unknown>).quality || {}) as Record<string, unknown>;
        acc.calls += toNumber(quality.l30DaysTotalCalls);
        acc.payers += toNumber(quality.l30DaysUniquePayers);
        return acc;
      },
      { calls: 0, payers: 0 },
    );
    const priceSummary = (svc.priceSummary || {}) as Record<string, unknown>;
    return {
      id: String(svc.id || ""),
      name: String(svc.name || svc.serviceName || svc.id || "unknown"),
      category: String(svc.category || ""),
      description: String(svc.description || "").slice(0, 280),
      minAmount: String(priceSummary.minAmount || ""),
      maxAmount: String(priceSummary.maxAmount || ""),
      currency: String(priceSummary.currency || "USDC"),
      networks: Array.isArray(svc.networks) ? svc.networks.map(String) : [],
      calls30d: qualityRollup.calls,
      uniquePayers30d: qualityRollup.payers,
      endpoints,
    };
  });
  const priced = sellers
    .filter((s) => s.minAmount !== "" && Number.isFinite(Number(s.minAmount)))
    .sort((a, b) => Number(a.minAmount) - Number(b.minAmount));
  const hottest = [...sellers].sort((a, b) => b.calls30d - a.calls30d)[0] || null;
  return {
    query,
    count: sellers.length,
    cheapest: priced[0] || null,
    hottest,
    sellers,
    rankedAt: new Date().toISOString(),
  };
}

export async function inspectPayTo(input: { address: unknown; network?: unknown }) {
  const address = parseAddress(input.address, "payTo");
  const network = String(input.network || "base").toLowerCase();
  const token = USDC_BY_NETWORK[network];
  if (!token) {
    throw new Error(`Unsupported network "${network}". Use base, ethereum, arbitrum, optimism, polygon.`);
  }
  const [usdc, native] = await Promise.all([
    getBalance({ address, network, token }),
    getBalance({ address, network }),
  ]);
  return {
    address,
    network,
    usdcBalance: usdc.balance,
    nativeBalance: native.balance,
    nativeSymbol: native.symbol,
    recommendation:
      Number(usdc.balance) > 0
        ? "payTo already holds USDC on this chain — typical live merchant."
        : "payTo holds 0 USDC. Confirm the address before sending a first payment.",
    inspectedAt: new Date().toISOString(),
  };
}

export async function getUsdcInventory(input: { address: unknown; networks?: unknown }) {
  const address = parseAddress(input.address);
  const networks =
    input.networks === undefined
      ? ["base", "ethereum", "arbitrum", "optimism", "polygon"]
      : Array.isArray(input.networks)
        ? input.networks.map(String)
        : [String(input.networks)];
  if (networks.length > 5) {
    throw new Error("networks supports at most 5 chains");
  }
  const rows = [];
  for (const network of networks) {
    const token = USDC_BY_NETWORK[network];
    if (!token) {
      rows.push({ network, usdc: "n/a", native: "n/a", nativeSymbol: "?", error: "unsupported network" });
      continue;
    }
    try {
      const [usdc, native] = await Promise.all([
        getBalance({ address, network, token }),
        getBalance({ address, network }),
      ]);
      rows.push({ network, usdc: usdc.balance, native: native.balance, nativeSymbol: native.symbol });
    } catch (error) {
      rows.push({
        network,
        usdc: "n/a",
        native: "n/a",
        nativeSymbol: "?",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const total = rows.reduce((sum, row) => sum + (Number.isFinite(Number(row.usdc)) ? Number(row.usdc) : 0), 0);
  return { address, totalUsdc: total.toFixed(6), rows, snappedAt: new Date().toISOString() };
}

export async function adviseCongestion(input: { network?: unknown } = {}) {
  const network = String(input.network || "base");
  const oracle = await getGasOracle({ network });
  const row = oracle.networks[0];
  if (!row) throw new Error(`No gas data for ${network}`);
  if (row.error) {
    return {
      network: row.network,
      congestion: "unknown" as const,
      gasPriceGwei: "0",
      baseFeeGwei: null,
      advice: `Oracle error: ${row.error}`,
      quotedAt: oracle.timestamp,
    };
  }
  const gwei = Number(row.baseFeeGwei ?? row.gasPriceGwei);
  const congestion =
    row.network === "ethereum"
      ? gwei < 8
        ? "low"
        : gwei < 30
          ? "medium"
          : "high"
      : gwei < 0.05
        ? "low"
        : gwei < 0.3
          ? "medium"
          : "high";
  const advice =
    congestion === "low"
      ? "Submit now. Fees are cheap relative to recent L2 baselines."
      : congestion === "medium"
        ? "Submit if the paid call is time-sensitive; otherwise wait one block."
        : "Defer non-urgent writes. Congestion is elevated.";
  return {
    network: row.network,
    congestion,
    gasPriceGwei: row.gasPriceGwei,
    baseFeeGwei: row.baseFeeGwei,
    advice,
    quotedAt: oracle.timestamp,
  };
}
