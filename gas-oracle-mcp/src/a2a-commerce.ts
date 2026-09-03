import { assertSafePublicUrl } from "./http-safety.js";
import { getBalance, getTxStatus } from "./gas.js";
import { estimateTxCost, getGasOracle } from "./gas-oracle.js";

const USDC_ADDRESSES = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
} as const;

export type CommerceNetwork = keyof typeof USDC_ADDRESSES;

export function networkFromCaip(caip: unknown): CommerceNetwork | null {
  const networks: Record<string, CommerceNetwork> = {
    "eip155:8453": "base",
    "eip155:1": "ethereum",
    "eip155:42161": "arbitrum",
    "eip155:10": "optimism",
    "eip155:137": "polygon",
  };
  return networks[String(caip).trim()] || null;
}

function parseJson(value: unknown): Record<string, any> | null {
  if (typeof value === "object" && value !== null) return value as Record<string, any>;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as Record<string, any>;
  } catch {
    try {
      return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Record<string, any>;
    } catch {
      return null;
    }
  }
}

export function parseX402Challenge(input: {
  body?: unknown;
  paymentRequiredHeader?: string | null;
}): { paymentRequired: boolean; accepts: any[]; raw?: Record<string, any> } {
  const body = parseJson(input.body);
  const header = parseJson(input.paymentRequiredHeader);
  const raw = header || body;
  if (!raw) return { paymentRequired: false, accepts: [] };
  const accepts = Array.isArray(raw.accepts) ? raw.accepts : raw.scheme ? [raw] : [];
  return { paymentRequired: accepts.length > 0, accepts, raw };
}

export async function probeX402Resource(input: { url: string }): Promise<Record<string, unknown>> {
  try {
    const url = await assertSafePublicUrl(input.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      let response: Response;
      let currentUrl = url;
      for (let redirects = 0; ; redirects++) {
        response = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
        });
        const location = response.headers.get("location");
        if (!location || response.status < 300 || response.status >= 400) break;
        if (redirects >= 5) throw new Error("Too many redirects");
        currentUrl = await assertSafePublicUrl(new URL(location, currentUrl).toString());
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 64 * 1024) {
            await reader.cancel();
            break;
          }
          chunks.push(value);
        }
      } else {
        const value = new Uint8Array(await response.arrayBuffer());
        size = value.byteLength;
        if (size <= 64 * 1024) chunks.push(value);
      }
      const text = size <= 64 * 1024 ? Buffer.concat(chunks).toString("utf8") : "";
      const challenge = parseX402Challenge({
        body: parseJson(text) || text,
        paymentRequiredHeader: response.headers.get("PAYMENT-REQUIRED"),
      });
      return {
        url: currentUrl.toString(),
        status: response.status,
        contentType: response.headers.get("content-type"),
        bodyBytes: size,
        ...challenge,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { paymentRequired: false, accepts: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function checkUsdcReadiness(input: {
  address: string;
  network?: string;
}): Promise<Record<string, unknown>> {
  const network = (input.network || "base") as CommerceNetwork;
  const token = USDC_ADDRESSES[network];
  if (!token) throw new Error(`Unsupported USDC network "${input.network}"`);
  const result = await getBalance({ address: input.address, network, token });
  return { ready: Number(result.balance) > 0, address: input.address, network, token, balance: result.balance, decimals: result.decimals };
}

export async function inspectPayability(input: {
  url: string;
  buyerAddress?: string;
}): Promise<Record<string, unknown>> {
  const probe = await probeX402Resource({ url: input.url });
  const network = (probe.accepts as any[]).map((a) => networkFromCaip(a.network)).find(Boolean) as CommerceNetwork | undefined;
  const usdc = input.buyerAddress && network ? await checkUsdcReadiness({ address: input.buyerAddress, network }) : undefined;
  return { ...probe, ...(usdc ? { usdc } : {}) };
}

export async function walletReadyBundle(input: {
  address: string;
  network?: string;
  recentTxHash?: string;
}): Promise<Record<string, unknown>> {
  const network = input.network || "base";
  const [gasOracle, gasCost, balance, txStatus] = await Promise.all([
    getGasOracle({ network }),
    estimateTxCost({ chain: network, gasLimit: 65000 }),
    getBalance({ address: input.address, network }),
    input.recentTxHash ? getTxStatus({ hash: input.recentTxHash, network }) : Promise.resolve(undefined),
  ]);
  return { address: input.address, network, gasOracle, gasCost, balance, ...(txStatus ? { txStatus } : {}) };
}

export function scoreAddressLookalike(input: { expected: string; actual: string }): {
  same: boolean;
  risk: "none" | "low" | "high";
  sharedPrefix: number;
  sharedSuffix: number;
} {
  const expected = input.expected.toLowerCase();
  const actual = input.actual.toLowerCase();
  let prefix = 0;
  while (prefix < expected.length && prefix < actual.length && expected[prefix] === actual[prefix]) prefix++;
  let suffix = 0;
  while (suffix < expected.length && suffix < actual.length && expected.at(-1 - suffix) === actual.at(-1 - suffix)) suffix++;
  const same = expected === actual;
  return { same, risk: same ? "none" : prefix >= 6 && suffix >= 4 ? "high" : prefix >= 4 || suffix >= 4 ? "low" : "none", sharedPrefix: prefix, sharedSuffix: suffix };
}
