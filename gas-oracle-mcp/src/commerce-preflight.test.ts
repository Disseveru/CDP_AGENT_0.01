import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { preflightPaySession, scoreX402Seller } from "./commerce-preflight.js";

const goodPayload = {
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      asset: "USDC",
      payTo: "0x0000000000000000000000000000000000000001",
      maxAmountRequired: "2000",
    },
  ],
};

describe("scoreX402Seller", () => {
  it("scores a standard Base USDC exact challenge as low/medium", () => {
    const result = scoreX402Seller(goodPayload, 402);
    assert.ok(result.score < 55, `expected low/medium score, got ${result.score}`);
    assert.equal(result.decode.cheapestUsd, 0.002);
    assert.ok(result.decode.paymentRequired);
  });

  it("flags zero-address payTo as critical", () => {
    const result = scoreX402Seller({
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "USDC",
          payTo: "0x0000000000000000000000000000000000000000",
          maxAmountRequired: "2000",
        },
      ],
    });
    assert.ok(result.flags.includes("payTo_zero_address"));
    assert.ok(result.score >= 55);
  });
});

describe("preflightPaySession", () => {
  it("allows a funded buyer against a cheap clean quote", () => {
    const result = preflightPaySession({
      balanceUsd: "1.00",
      reserveUsd: "0.10",
      payload: goodPayload,
      httpStatus: 402,
    });
    assert.equal(result.priceUsd, 0.002);
    assert.equal(result.spend.canAffordAtLeastOne, true);
    assert.equal(result.canPay, true);
    assert.deepEqual(result.blockers, []);
  });

  it("blocks when the buyer cannot afford the listed price", () => {
    const result = preflightPaySession({
      balanceUsd: "0.001",
      reserveUsd: "0.001",
      payload: goodPayload,
      httpStatus: 402,
    });
    assert.equal(result.canPay, false);
    assert.ok(result.blockers.includes("insufficient_balance"));
  });
});
