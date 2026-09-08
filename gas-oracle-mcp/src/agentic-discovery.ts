/**
 * Discovery SKUs for buyer agents: Agentic.Market catalog search
 * and facilitator liveness. Network calls are injectable for tests.
 */

export const AGENTIC_MARKET_SERVICES_URL = "https://api.agentic.market/v1/services";
export const AGENTIC_MARKET_SEARCH_URL = "https://api.agentic.market/v1/services/search";

export const DEFAULT_FACILITATORS: ReadonlyArray<{ id: string; url: string }> = [
  { id: "coinbase-cdp", url: "https://api.cdp.coinbase.com/platform/v2/x402" },
  { id: "xpay", url: "https://facilitator.xpay.sh" },
];

const MAX_Q_LEN = 80;
const FETCH_TIMEOUT_MS = 8_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  void t;
  return ctrl.signal;
}

export function sanitizeQuery(q: string): string {
  const trimmed = q.trim().slice(0, MAX_Q_LEN);
  if (!trimmed) throw new Error("q must be a non-empty search string");
  return trimmed;
}

export interface MarketServiceSummary {
  id?: string;
  name?: string;
  description?: string;
  category?: string;
  networks?: string[];
  endpointCount?: number;
  minPriceUsd?: string;
}

export interface SearchAgenticMarketResult {
  query: string;
  source: string;
  count: number;
  services: MarketServiceSummary[];
}

function summarizeService(raw: unknown): MarketServiceSummary {
  if (!raw || typeof raw !== "object") return {};
  const s = raw as Record<string, unknown>;
  const endpoints = Array.isArray(s.endpoints) ? s.endpoints : [];
  let min: number | undefined;
  for (const ep of endpoints) {
    if (!ep || typeof ep !== "object") continue;
    const pricing = (ep as Record<string, unknown>).pricing;
    if (pricing && typeof pricing === "object") {
      const amount = Number((pricing as Record<string, unknown>).amount);
      if (Number.isFinite(amount)) min = min === undefined ? amount : Math.min(min, amount);
    }
  }
  return {
    id: typeof s.id === "string" ? s.id : undefined,
    name: typeof s.name === "string" ? s.name : undefined,
    description: typeof s.description === "string" ? s.description.slice(0, 280) : undefined,
    category: typeof s.category === "string" ? s.category : undefined,
    networks: Array.isArray(s.networks) ? s.networks.filter((n): n is string => typeof n === "string") : undefined,
    endpointCount: endpoints.length || undefined,
    minPriceUsd: min !== undefined ? String(min) : undefined,
  };
}

export async function searchAgenticMarket(
  args: { q: string; limit?: number },
  deps: { fetchImpl?: FetchLike } = {},
): Promise<SearchAgenticMarketResult> {
  const q = sanitizeQuery(args.q);
  const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 25);
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const url = `${AGENTIC_MARKET_SEARCH_URL}?q=${encodeURIComponent(q)}`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: withTimeout(),
  });
  if (!res.ok) {
    throw new Error(`agentic.market search failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { services?: unknown[] };
  const list = Array.isArray(body.services) ? body.services : [];
  const services = list.slice(0, limit).map(summarizeService);
  return {
    query: q,
    source: "api.agentic.market",
    count: services.length,
    services,
  };
}

export interface FacilitatorHealthRow {
  id: string;
  url: string;
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
}

export async function checkFacilitatorHealth(
  args: { urls?: Array<{ id?: string; url: string }> } = {},
  deps: { fetchImpl?: FetchLike } = {},
): Promise<{ checkedAt: string; facilitators: FacilitatorHealthRow[] }> {
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const targets = (args.urls && args.urls.length > 0 ? args.urls : DEFAULT_FACILITATORS).slice(0, 8);

  const rows = await Promise.all(
    targets.map(async (t): Promise<FacilitatorHealthRow> => {
      const started = Date.now();
      try {
        const parsed = new URL(t.url);
        if (parsed.protocol !== "https:") {
          return {
            id: t.id || parsed.hostname,
            url: t.url,
            ok: false,
            latencyMs: Date.now() - started,
            error: "only https facilitators are probed",
          };
        }
        const res = await fetchImpl(t.url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: withTimeout(),
        });
        return {
          id: t.id || parsed.hostname,
          url: t.url,
          ok: res.status < 500,
          status: res.status,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        return {
          id: t.id || "unknown",
          url: t.url,
          ok: false,
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  return { checkedAt: new Date().toISOString(), facilitators: rows };
}
