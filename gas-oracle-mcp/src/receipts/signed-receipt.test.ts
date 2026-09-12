import assert from "node:assert/strict";
import { issueReceipt, verifyReceipt, sha256Hex, facilitatorFailoverScore } from "./signed-receipt.ts";

const secret = "production-grade-secret-key";
const signed = issueReceipt(secret, {
  seller: "0xabc",
  buyer: "0xdef",
  tool: "quote_gas",
  requestHash: sha256Hex('{"chain":"base"}'),
  responseHash: sha256Hex('{"slow":1}'),
  amountAtomic: "10000",
  asset: "USDC",
  network: "eip155:8453",
});

const good = verifyReceipt(secret, signed);
assert.equal(good.ok, true);

const bad = verifyReceipt(secret, { ...signed, sig: "00".repeat(32) });
assert.equal(bad.ok, false);

const expired = verifyReceipt(secret, signed, Date.parse(signed.expiresAt) + 1);
assert.equal(expired.ok, false);

const ranked = facilitatorFailoverScore([
  { url: "a", ok: true, ms: 400 },
  { url: "b", ok: false, ms: 10 },
  { url: "c", ok: true, ms: 80 },
]);
assert.equal(ranked[0].url, "c");

console.log("signed-receipt tests ok");
