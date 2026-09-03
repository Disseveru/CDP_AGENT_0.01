/**
 * Normalize raw x402 payment headers / facilitator payloads into a receipt
 * a downstream agent can verify without re-implementing header parsing.
 */
export interface NormalizeReceiptInput {
  paymentRequiredHeader?: unknown;
  paymentSignatureHeader?: unknown;
  paymentResponseHeader?: unknown;
  txHash?: unknown;
}

export interface NormalizeReceiptResult {
  x402Version: number | null;
  scheme: string | null;
  network: string | null;
  payTo: string | null;
  asset: string | null;
  amountAtomic: string | null;
  amountUsd: number | null;
  txHash: string | null;
  payer: string | null;
  settled: boolean | null;
  raw: {
    required: unknown;
    signature: unknown;
    response: unknown;
  };
  normalizedAt: string;
}

function decodeMaybe(raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }
  try {
    return JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"));
  } catch {
    return trimmed;
  }
}

function firstString(obj: unknown, keys: string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
  }
  return null;
}

function firstAccept(obj: unknown): Record<string, unknown> | null {
  if (!obj || typeof obj !== "object") return null;
  const record = obj as Record<string, unknown>;
  if (Array.isArray(record.accepts) && record.accepts[0] && typeof record.accepts[0] === "object") {
    return record.accepts[0] as Record<string, unknown>;
  }
  return record;
}

export function normalizeX402Receipt(input: NormalizeReceiptInput): NormalizeReceiptResult {
  const required = decodeMaybe(input.paymentRequiredHeader);
  const signature = decodeMaybe(input.paymentSignatureHeader);
  const response = decodeMaybe(input.paymentResponseHeader);
  const accept = firstAccept(required);

  const amountAtomic =
    firstString(accept, ["maxAmountRequired", "amount", "value"]) ??
    firstString(response, ["amount", "maxAmountRequired"]);
  const amountUsd = amountAtomic && /^\d+$/.test(amountAtomic) ? Number(amountAtomic) / 1_000_000 : null;
  const explicitHash = typeof input.txHash === "string" && input.txHash.trim() ? input.txHash.trim() : null;
  const txHash =
    explicitHash ??
    firstString(response, ["txHash", "transaction", "hash", "settlementTx"]) ??
    firstString(signature, ["txHash", "hash"]);

  const versionRaw = firstString(required, ["x402Version"]) ?? firstString(response, ["x402Version"]);
  const settledHint = firstString(response, ["success", "settled", "status"]);

  return {
    x402Version: versionRaw && Number.isFinite(Number(versionRaw)) ? Number(versionRaw) : null,
    scheme: firstString(accept, ["scheme"]),
    network: firstString(accept, ["network"]) ?? firstString(response, ["network"]),
    payTo: firstString(accept, ["payTo"]) ?? firstString(response, ["payTo"]),
    asset: firstString(accept, ["asset"]),
    amountAtomic,
    amountUsd,
    txHash,
    payer: firstString(signature, ["from", "payer", "signer"]) ?? firstString(response, ["payer", "from"]),
    settled: settledHint === null ? null : /^(true|success|settled|1)$/i.test(settledHint),
    raw: { required, signature, response },
    normalizedAt: new Date().toISOString(),
  };
}
