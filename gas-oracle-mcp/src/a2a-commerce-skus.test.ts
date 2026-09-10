import assert from "node:assert/strict";
import test from "node:test";

import {
  a2aCommerceBundle,
  issueDeliveryReceipt,
  pickFacilitatorFailover,
  screenTokenAllowlist,
  verifyDeliveryReceipt,
} from "./a2a-commerce-skus.js";

test("screenTokenAllowlist accepts Base USDC", () => {
  const result = screenTokenAllowlist({
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    network: "eip155:8453",
    payTo: "0x0000000000000000000000000000000000000001",
  });
  assert.equal(result.allowed, true);
  assert.equal(result.symbol, "USDC");
});

test("screenTokenAllowlist rejects zero address", () => {
  const result = screenTokenAllowlist({
    asset: "0x0000000000000000000000000000000000000000",
    network: "base",
  });
  assert.equal(result.allowed, false);
  assert.equal(result.onDenylist, true);
});

test("screenTokenAllowlist rejects unknown tokens", () => {
  const result = screenTokenAllowlist({
    asset: "0x1111111111111111111111111111111111111111",
    network: "base",
  });
  assert.equal(result.allowed, false);
  assert.equal(result.onDefaultAllowlist, false);
});

test("issueDeliveryReceipt is verifiable", () => {
  const receipt = issueDeliveryReceipt({
    sku: "quote_gas",
    payload: { ok: true },
    buyer: "0xabc",
    seller: "agentwire",
  });
  assert.equal(receipt.alg, "hmac-sha256");
  assert.equal(verifyDeliveryReceipt(receipt), true);
  assert.equal(verifyDeliveryReceipt({ ...receipt, signature: "00".repeat(32) }), false);
});

test("pickFacilitatorFailover ranks live https first", async () => {
  const choice = await pickFacilitatorFailover(
    {
      urls: [
        { id: "dead", url: "https://facilitator.example.invalid" },
        { id: "live", url: "https://api.cdp.coinbase.com/platform/v2/x402" },
      ],
    },
    {
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("invalid")) throw new Error("dns");
        return new Response("{}", { status: 200 });
      },
    },
  );
  assert.equal(choice.selected?.id, "live");
  assert.match(choice.recommendation, /Use live/);
});

test("a2aCommerceBundle proceeds only when screen and facilitator pass", async () => {
  const bundled = await a2aCommerceBundle({
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    network: "base",
    payTo: "0x0000000000000000000000000000000000000001",
    sku: "bundle",
    payload: { n: 1 },
  });
  assert.equal(bundled.screen.allowed, true);
  assert.equal(typeof bundled.receipt.signature, "string");
  assert.equal(typeof bundled.proceed, "boolean");
});
