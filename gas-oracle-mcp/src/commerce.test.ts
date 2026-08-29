import assert from "node:assert/strict";
import test from "node:test";

import { decodePaymentChallenge, quoteAgentSpend } from "./commerce.js";

test("quoteAgentSpend totals SKUs and applies buffer", () => {
  const quote = quoteAgentSpend({
    bufferBps: 1000,
    lines: [
      { sku: "gas_oracle", unitPriceUsd: "$0.002", quantity: 10 },
      { sku: "fetch_url", unitPriceUsd: "0.012", quantity: 2 },
    ],
  });

  assert.equal(quote.lineCount, 2);
  assert.equal(quote.skuTotalUsd, "$0.044");
  assert.equal(quote.bufferUsd, "$0.0044");
  assert.equal(quote.recommendedWalletUsd, "$0.0484");
  assert.equal(quote.maxUnitPriceUsd, "$0.012");
});

test("quoteAgentSpend rejects empty carts and bad quantities", () => {
  assert.throws(() => quoteAgentSpend({ lines: [] }), /at least one SKU/);
  assert.throws(
    () => quoteAgentSpend({ lines: [{ sku: "x", unitPriceUsd: "$0.01", quantity: 0 }] }),
    /invalid quantity/,
  );
});

test("decodePaymentChallenge reads v2 accepts arrays", () => {
  const decoded = decodePaymentChallenge({
    payload: JSON.stringify({
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          payTo: "0x0000000000000000000000000000000000000001",
          price: "$0.02",
        },
        {
          scheme: "exact",
          network: "eip155:8453",
          payTo: "0x0000000000000000000000000000000000000001",
          price: "$0.005",
        },
      ],
    }),
  });

  assert.equal(decoded.paymentRequired, true);
  assert.equal(decoded.accepts.length, 2);
  assert.equal(decoded.cheapestUsd, 0.005);
  assert.equal(decoded.recommended?.price, "$0.005");
  assert.equal(decoded.rawType, "json");
});

test("decodePaymentChallenge handles invalid strings", () => {
  const decoded = decodePaymentChallenge({ payload: "not-json" });
  assert.equal(decoded.paymentRequired, false);
  assert.equal(decoded.rawType, "invalid");
});
