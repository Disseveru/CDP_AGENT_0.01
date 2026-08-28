import assert from "node:assert/strict";
import test from "node:test";

import { quoteSettlement } from "./quote-settlement.js";

test("quoteSettlement returns gas quote without resource", async () => {
  const result = await quoteSettlement({ chain: "base" });
  assert.equal(result.chain, "base");
  assert.ok(Number(result.gas.maxFeeGwei) >= 0);
  assert.equal(result.x402.probed, false);
  assert.ok(result.recommendation.includes("Budget"));
});

test("quoteSettlement combines probe + gas", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "5000",
            asset: "0xUSDC",
            payTo: "0xpay",
          },
        ],
      }),
      { status: 402, headers: { "content-type": "application/json" } },
    );

  try {
    const result = await quoteSettlement({
      resourceUrl: "https://example.com/sku",
      chain: "base",
    });
    assert.equal(result.x402.probed, true);
    assert.equal(result.x402.paymentRequired, true);
    assert.equal(result.x402.lowestPriceUsdc, "0.005000");
    assert.ok(result.recommendation.includes("Pay x402"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
