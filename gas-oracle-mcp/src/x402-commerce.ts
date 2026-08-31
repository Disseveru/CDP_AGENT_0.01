/**
 * x402 agent-commerce SKUs that other marketplaces under-serve:
 *  - decode a 402 / PAYMENT-REQUIRED challenge before spending
 *  - confirm USDC Transfer logs (not just tx.to)
 *  - inspect payTo (EOA vs contract)
 *  - pre-flight "can I buy this" bundle
 */
import { formatUnits, isAddress, parseAbiItem, type Address, type Hash, type Hex } from "viem";

import { planAgentSpend, parseUsdAmount, type PlanAgentSpendResult } from "./agent-commerce.js";
import {
  getGasPublicClient,
  getTxStatus,
  parseEvmAddress,
  resolveGasNetwork,
  type GasNetwork,
  type GetTxStatusResult,
} from "./gas.js";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** Canonical USDC (not bridged USDbC) per network. */
export const USDC_BY_NETWORK: Record<GasNetwork, Address> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432D147f171",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
};

const USDC_DECIMALS = 6;

export interface DecodedAcceptOption {
  scheme: string | null;
  network: string | null;
  asset: string | null;
  payTo: string | null;
  maxAmountRequired: string | null;
  extra: Record<string, unknown>;
}

export interface DecodePaymentRequiredResult {
  decoded: boolean;
  source: "header" | "json" | "object";
  rawType: string;
  accepts: DecodedAcceptOption[];
  resource: string | null;
  description: string | null;
  recommendation: string;
  decodedAt: string;
}

function tryBase64Json(raw: string): unknown | null {
  const compact = raw.trim();
  if (!compact || compact.includes(" ") || compact.length < 8) return null;
  try {
    const decoded = Buffer.from(compact, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickAccepts(payload: Record<string, unknown>): unknown[] {
  const accepts = payload.accepts ?? payload.accepted ?? payload.paymentRequirements;
  if (Array.isArray(accepts)) return accepts;
  if (accepts && typeof accepts === "object") return [accepts];
  if (payload.scheme || payload.network || payload.payTo) return [payload];
  return [];
}

function normalizeAccept(raw: unknown): DecodedAcceptOption {
  const rec = asRecord(raw) ?? {};
  const extra = { ...rec };
  return {
    scheme: rec.scheme != null ? String(rec.scheme) : null,
    network: rec.network != null ? String(rec.network) : rec.chain != null ? String(rec.chain) : null,
    asset: rec.asset != null ? String(rec.asset) : rec.token != null ? String(rec.token) : null,
    payTo:
      rec.payTo != null
        ? String(rec.payTo)
        : rec.payto != null
          ? String(rec.payto)
          : rec.recipient != null
            ? String(rec.recipient)
            : null,
    maxAmountRequired:
      rec.maxAmountRequired != null
        ? String(rec.maxAmountRequired)
        : rec.amount != null
          ? String(rec.amount)
          : rec.price != null
            ? String(rec.price)
            : null,
    extra,
  };
}

export function decodePaymentRequired(input: { payload: unknown }): DecodePaymentRequiredResult {
  if (input.payload === undefined || input.payload === null || input.payload === "") {
    throw new Error("payload is required");
  }

  let source: DecodePaymentRequiredResult["source"] = "object";
  let parsed: unknown = input.payload;

  if (typeof input.payload === "string") {
    const trimmed = input.payload.trim();
    let asJson: unknown = null;
    try {
      asJson = JSON.parse(trimmed);
    } catch {
      asJson = null;
    }
    const asB64 = tryBase64Json(trimmed);
    if (asJson !== null) {
      parsed = asJson;
      source = "json";
    } else if (asB64 !== null) {
      parsed = asB64;
      source = "header";
    } else {
      throw new Error("payload must be JSON or base64-encoded PAYMENT-REQUIRED JSON");
    }
  }

  const record = asRecord(parsed);
  if (!record) {
    throw new Error("decoded payload is not a JSON object");
  }

  const accepts = pickAccepts(record).map(normalizeAccept);
  const resource =
    record.resource != null ? String(record.resource) : record.url != null ? String(record.url) : null;
  const description = record.description != null ? String(record.description) : null;

  let recommendation: string;
  if (accepts.length === 0) {
    recommendation = "No payment options found. Do not spend until the seller returns accepts[].";
  } else if (!accepts.some((row) => row.payTo && row.maxAmountRequired)) {
    recommendation = "Options decoded but payTo or amount is missing. Inspect before paying.";
  } else {
    recommendation = `Decoded ${accepts.length} payment option(s). Confirm payTo and amount before signing.`;
  }

  return {
    decoded: accepts.length > 0,
    source,
    rawType: typeof parsed,
    accepts,
    resource,
    description,
    recommendation,
    decodedAt: new Date().toISOString(),
  };
}

export interface InspectPayToResult {
  network: GasNetwork;
  address: Address;
  isContract: boolean;
  bytecodeBytes: number;
  nonce: number;
  kind: "eoa" | "contract";
  recommendation: string;
  inspectedAt: string;
}

export async function inspectPayTo(input: {
  address: string;
  network?: string;
}): Promise<InspectPayToResult> {
  const network = resolveGasNetwork(input.network || "base");
  const address = parseEvmAddress(input.address, "payTo");
  const client = getGasPublicClient(network);
  const [code, nonce] = await Promise.all([
    client.getCode({ address }),
    client.getTransactionCount({ address }),
  ]);
  const bytecode = (code ?? "0x") as Hex;
  const bytecodeBytes = bytecode === "0x" ? 0 : (bytecode.length - 2) / 2;
  const isContract = bytecodeBytes > 0;
  return {
    network,
    address,
    isContract,
    bytecodeBytes,
    nonce,
    kind: isContract ? "contract" : "eoa",
    recommendation: isContract
      ? "payTo is a contract. Confirm it is the expected facilitator/receiver before sending USDC."
      : "payTo is an EOA. Fine for exact transfers; unusual for smart-wallet sellers.",
    inspectedAt: new Date().toISOString(),
  };
}

export interface UsdcTransferMatch {
  from: string;
  to: string;
  amountAtomic: string;
  amountUsdc: string;
  logIndex: number;
}

export interface VerifyUsdcTransferResult {
  verified: boolean;
  reason: string;
  network: GasNetwork;
  usdc: Address;
  expectedTo: string | null;
  expectedMinUsdc: string | null;
  matches: UsdcTransferMatch[];
  tx: GetTxStatusResult;
}

export async function verifyUsdcTransfer(input: {
  hash: string;
  network?: string;
  expectedTo?: string;
  expectedMinUsdc?: unknown;
}): Promise<VerifyUsdcTransferResult> {
  const network = resolveGasNetwork(input.network || "base");
  const usdc = USDC_BY_NETWORK[network];
  const expectedTo = input.expectedTo ? parseEvmAddress(input.expectedTo, "expectedTo") : null;
  const expectedMinUsdc =
    input.expectedMinUsdc === undefined || input.expectedMinUsdc === null
      ? null
      : parseUsdAmount(input.expectedMinUsdc, "expectedMinUsdc");

  const tx = await getTxStatus({ hash: input.hash, network });
  if (tx.status !== "success") {
    return {
      verified: false,
      reason: `Transaction is ${tx.status}; USDC Transfer cannot be confirmed.`,
      network,
      usdc,
      expectedTo,
      expectedMinUsdc: expectedMinUsdc !== null ? String(expectedMinUsdc) : null,
      matches: [],
      tx,
    };
  }

  const client = getGasPublicClient(network);
  const receipt = await client.getTransactionReceipt({ hash: tx.hash as Hash });
  const matches: UsdcTransferMatch[] = [];

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdc.toLowerCase()) continue;
    try {
      const topics = log.topics as [Hex, ...Hex[]];
      const decoded = client.decodeEventLog({
        abi: [TRANSFER_EVENT],
        data: log.data,
        topics,
      });
      if (decoded.eventName !== "Transfer") continue;
      const args = decoded.args as { from: Address; to: Address; value: bigint };
      matches.push({
        from: args.from,
        to: args.to,
        amountAtomic: args.value.toString(),
        amountUsdc: formatUnits(args.value, USDC_DECIMALS),
        logIndex: log.logIndex,
      });
    } catch {
      continue;
    }
  }

  const filtered = expectedTo
    ? matches.filter((row) => row.to.toLowerCase() === expectedTo.toLowerCase())
    : matches;

  const sufficient =
    expectedMinUsdc === null
      ? filtered
      : filtered.filter((row) => Number(row.amountUsdc) + 1e-12 >= expectedMinUsdc);

  if (matches.length === 0) {
    return {
      verified: false,
      reason:
        "No USDC Transfer logs found. Native ETH value or a non-USDC token is not an x402 settlement.",
      network,
      usdc,
      expectedTo,
      expectedMinUsdc: expectedMinUsdc !== null ? String(expectedMinUsdc) : null,
      matches,
      tx,
    };
  }

  if (expectedTo && filtered.length === 0) {
    return {
      verified: false,
      reason: `USDC moved, but no Transfer to expectedTo=${expectedTo}.`,
      network,
      usdc,
      expectedTo,
      expectedMinUsdc: expectedMinUsdc !== null ? String(expectedMinUsdc) : null,
      matches,
      tx,
    };
  }

  if (expectedMinUsdc !== null && sufficient.length === 0) {
    return {
      verified: false,
      reason: `USDC Transfer found but amount is below expectedMinUsdc=${expectedMinUsdc}.`,
      network,
      usdc,
      expectedTo,
      expectedMinUsdc: String(expectedMinUsdc),
      matches,
      tx,
    };
  }

  return {
    verified: true,
    reason: "USDC Transfer log confirmed on-chain.",
    network,
    usdc,
    expectedTo,
    expectedMinUsdc: expectedMinUsdc !== null ? String(expectedMinUsdc) : null,
    matches: sufficient.length ? sufficient : filtered,
    tx,
  };
}

export interface CheckBuyReadinessResult {
  decoded: DecodePaymentRequiredResult;
  plan: PlanAgentSpendResult | null;
  payTo: InspectPayToResult | null;
  ready: boolean;
  recommendation: string;
}

export async function checkBuyReadiness(input: {
  payload: unknown;
  balanceUsd: unknown;
  reserveUsd?: unknown;
  network?: string;
}): Promise<CheckBuyReadinessResult> {
  const decoded = decodePaymentRequired({ payload: input.payload });
  const first = decoded.accepts[0];
  let plan: PlanAgentSpendResult | null = null;
  if (first?.maxAmountRequired) {
    const price =
      first.maxAmountRequired.startsWith("$") || first.maxAmountRequired.includes(".")
        ? first.maxAmountRequired
        : Number(first.maxAmountRequired) / 1_000_000;
    plan = planAgentSpend({
      balanceUsd: input.balanceUsd,
      pricePerCallUsd: price,
      reserveUsd: input.reserveUsd,
      maxCalls: 1,
    });
  }

  let payTo: InspectPayToResult | null = null;
  if (first?.payTo && isAddress(first.payTo)) {
    payTo = await inspectPayTo({ address: first.payTo, network: input.network || "base" });
  }

  const ready = Boolean(decoded.decoded && plan?.canAffordAtLeastOne && first?.payTo);
  const recommendation = !decoded.decoded
    ? decoded.recommendation
    : !plan
      ? "Decoded seller terms but could not parse a price. Do not pay yet."
      : !plan.canAffordAtLeastOne
        ? plan.recommendation
        : ready
          ? "Ready to pay one call. Confirm payTo, then attach PAYMENT-SIGNATURE and retry."
          : "Terms decoded but payTo is missing. Do not sign.";

  return { decoded, plan, payTo, ready, recommendation };
}
