import { createHmac, createHash, timingSafeEqual, randomBytes } from "node:crypto";

export type DeliveryReceipt = {
  v: 1;
  seller: string;
  buyer?: string;
  tool: string;
  requestHash: string;
  responseHash: string;
  amountAtomic: string;
  asset: string;
  network: string;
  paymentTx?: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
};

export type SignedDeliveryReceipt = DeliveryReceipt & {
  alg: "HS256";
  sig: string;
};

function canonical(receipt: DeliveryReceipt): string {
  return JSON.stringify({
    v: receipt.v,
    seller: receipt.seller,
    buyer: receipt.buyer ?? "",
    tool: receipt.tool,
    requestHash: receipt.requestHash,
    responseHash: receipt.responseHash,
    amountAtomic: receipt.amountAtomic,
    asset: receipt.asset,
    network: receipt.network,
    paymentTx: receipt.paymentTx ?? "",
    issuedAt: receipt.issuedAt,
    expiresAt: receipt.expiresAt,
    nonce: receipt.nonce,
  });
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function issueReceipt(
  secret: string,
  partial: Omit<DeliveryReceipt, "v" | "issuedAt" | "expiresAt" | "nonce"> & {
    ttlMs?: number;
  }
): SignedDeliveryReceipt {
  if (!secret || secret.length < 16) {
    throw new Error("RECEIPT_SECRET must be at least 16 characters");
  }
  const now = Date.now();
  const receipt: DeliveryReceipt = {
    v: 1,
    seller: partial.seller,
    buyer: partial.buyer,
    tool: partial.tool,
    requestHash: partial.requestHash,
    responseHash: partial.responseHash,
    amountAtomic: partial.amountAtomic,
    asset: partial.asset,
    network: partial.network,
    paymentTx: partial.paymentTx,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (partial.ttlMs ?? 24 * 60 * 60 * 1000)).toISOString(),
    nonce: randomBytes(16).toString("hex"),
  };
  const sig = createHmac("sha256", secret).update(canonical(receipt)).digest("hex");
  return { ...receipt, alg: "HS256", sig };
}

export function verifyReceipt(
  secret: string,
  signed: SignedDeliveryReceipt,
  now = Date.now()
): { ok: true; receipt: DeliveryReceipt } | { ok: false; reason: string } {
  if (!signed || signed.v !== 1 || signed.alg !== "HS256" || !signed.sig) {
    return { ok: false, reason: "malformed" };
  }
  const receipt: DeliveryReceipt = {
    v: 1,
    seller: signed.seller,
    buyer: signed.buyer,
    tool: signed.tool,
    requestHash: signed.requestHash,
    responseHash: signed.responseHash,
    amountAtomic: signed.amountAtomic,
    asset: signed.asset,
    network: signed.network,
    paymentTx: signed.paymentTx,
    issuedAt: signed.issuedAt,
    expiresAt: signed.expiresAt,
    nonce: signed.nonce,
  };
  const expected = createHmac("sha256", secret).update(canonical(receipt)).digest();
  const given = Buffer.from(signed.sig, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad_signature" };
  }
  if (Number.isNaN(Date.parse(signed.expiresAt)) || Date.parse(signed.expiresAt) < now) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, receipt };
}

export function facilitatorFailoverScore(probes: Array<{ url: string; ok: boolean; ms: number }>) {
  return [...probes]
    .map((p) => ({
      ...p,
      score: p.ok ? Math.max(0, 1000 - p.ms) : -1,
    }))
    .sort((a, b) => b.score - a.score);
}
