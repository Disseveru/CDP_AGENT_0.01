import assert from "node:assert/strict";
import test from "node:test";

import { compareSellerQuotes, decode402Payload } from "./x402-commerce.js";

test("decode402Payload reads accepts[] and cheapest atomic USDC", () => {
  const decoded = decode402Payload(
    {
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "USDC",
          payTo: "0xabc",
          maxAmountRequired: "7000",
        },
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "USDC",
          payTo: "0xdef",
          maxAmountRequired: "0.001",
        },
      ],
    },
    402,
  );
  assert.equal(decoded.paymentRequired, true);
  assert.equal(decoded.requirementCount, 2);
  assert.equal(decoded.cheapestUsd, 0.001);
  assert.equal(decoded.requirements[0].network, "eip155:8453");
});

test("decode402Payload warns on empty junk", () => {
  const decoded = decode402Payload({ hello: "world" });
  assert.equal(decoded.requirementCount, 0);
  assert.ok(decoded.warnings.length >= 1);
});

test("compareSellerQuotes ranks and reports savings", () => {
  const result = compareSellerQuotes([
    { name: "slow", priceUsd: "0.02", network: "base" },
    { name: "fast", priceUsd: "$0.005", network: "base" },
  ]);
  assert.equal(result.cheapest?.name, "fast");
  assert.equal(result.savingsVsMostExpensiveUsd, 0.015);
});

test("compareSellerQuotes rejects empty list", () => {
  assert.throws(() => compareSellerQuotes([]), /non-empty/);
});
