import assert from "node:assert/strict";
import test from "node:test";

import {
  bundleAgentQuote,
  issueDeliveryReceipt,
  pickFacilitatorFailover,
  screenPayee,
  verifyDeliveryReceipt,
} from "./a2a-sku.js";

test("screenPayee blocks denylisted payTo", () => {
  const result = screenPayee({
    payTo: "0x0000000000000000000000000000000000000001",
    denylist: ["0x0000000000000000000000000000000000000001"],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.checks.onDenylist, true);
});

test("screenPayee enforces allowlist and price cap", () => {
  const good = screenPayee({
    payTo: "0x0000000000000000000000000000000000000002",
    allowlist: ["0x0000000000000000000000000000000000000002"],
    listedPriceUsd: "0.01",
    maxPriceUsd: "0.05",
  });
  assert.equal(good.allowed, true);

  const expensive = screenPayee({
    payTo: "0x0000000000000000000000000000000000000002",
    allowlist: ["0x0000000000000000000000000000000000000002"],
    listedPriceUsd: "1.00",
    maxPriceUsd: "0.05",
  });
  assert.equal(expensive.allowed, false);
});

test("bundleAgentQuote totals SKUs and discount", () => {
  const quote = bundleAgentQuote(
    [
      { sku: "quote_gas", priceUsd: "$0.002", qty: 10 },
      { sku: "verify_settlement", priceUsd: 0.003, qty: 2 },
    ],
    "0.004",
  );
  assert.equal(quote.subtotalUsd, 0.026);
  assert.equal(quote.totalUsd, 0.022);
  assert.match(quote.recommendation, /Pay \$0.022000/);
});

test("delivery receipts verify with HMAC", () => {
  process.env.RECEIPT_HMAC_SECRET = "unit-test-secret";
  const receipt = issueDeliveryReceipt({
    sku: "fetch_url",
    buyer: "0xbuyer",
    seller: "0xseller",
    amountUsd: "0.012",
    contentHash: "abc123def4567890",
  });
  const ok = verifyDeliveryReceipt(receipt);
  assert.equal(ok.valid, true);
  const bad = verifyDeliveryReceipt({ ...receipt, signature: "00".repeat(32) });
  assert.equal(bad.valid, false);
});

test("pickFacilitatorFailover prefers live low-latency rail", () => {
  const pick = pickFacilitatorFailover([
    { name: "down", url: "https://down.example", ok: false, latencyMs: null, error: "timeout" },
    { name: "slow", url: "https://slow.example", ok: true, latencyMs: 400 },
    { name: "fast", url: "https://fast.example", ok: true, latencyMs: 40 },
  ]);
  assert.equal(pick.selected?.name, "fast");
  assert.match(pick.recommendation, /fast/);
});
