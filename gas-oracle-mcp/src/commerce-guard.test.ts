import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  auditX402Challenge,
  estimateSellerUnitEconomics,
  fingerprintPaymentIntent,
} from "./commerce-guard.js";

const cleanPayload = {
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

describe("auditX402Challenge", () => {
  it("scores a clean Base USDC challenge as safe", () => {
    const result = auditX402Challenge(cleanPayload, 402);
    assert.equal(result.safeToPay, true);
    assert.ok(result.score >= 80);
    assert.equal(result.cheapestUsd, 0.002);
    assert.equal(result.payToSet.length, 1);
  });

  it("blocks a missing payTo", () => {
    const result = auditX402Challenge({
      accepts: [{ scheme: "exact", network: "eip155:8453", maxAmountRequired: "1000" }],
    });
    assert.equal(result.safeToPay, false);
    assert.ok(result.findings.some((f) => f.code === "MISSING_PAYTO"));
  });

  it("blocks the zero address", () => {
    const result = auditX402Challenge({
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          payTo: "0x0000000000000000000000000000000000000000",
          maxAmountRequired: "1000",
        },
      ],
    });
    assert.equal(result.safeToPay, false);
    assert.ok(result.findings.some((f) => f.code === "ZERO_PAYTO"));
  });

  it("blocks empty payloads", () => {
    const result = auditX402Challenge({});
    assert.equal(result.safeToPay, false);
    assert.equal(result.score, 0);
  });
});

describe("fingerprintPaymentIntent", () => {
  it("is stable for the same inputs", () => {
    const a = fingerprintPaymentIntent({
      payTo: "0xABC",
      network: "eip155:8453",
      amountUsd: "$0.01",
      resource: "/quote",
    });
    const b = fingerprintPaymentIntent({
      payTo: "0xabc",
      network: "EIP155:8453",
      amountUsd: "0.01",
      resource: "/quote",
    });
    assert.equal(a.fingerprint, b.fingerprint);
    assert.equal(a.fingerprint.length, 64);
  });

  it("changes when amount changes", () => {
    const a = fingerprintPaymentIntent({
      payTo: "0x1",
      network: "base",
      amountUsd: "0.01",
    });
    const b = fingerprintPaymentIntent({
      payTo: "0x1",
      network: "base",
      amountUsd: "0.02",
    });
    assert.notEqual(a.fingerprint, b.fingerprint);
  });
});

describe("estimateSellerUnitEconomics", () => {
  it("computes net after cost and facilitator bps", () => {
    const result = estimateSellerUnitEconomics({
      priceUsd: "$0.01",
      expectedDailyCalls: 1000,
      costPerCallUsd: "0.001",
      facilitatorFeeBps: 100,
    });
    assert.equal(result.viable, true);
    assert.equal(result.facilitatorFeeUsd, 0.0001);
    assert.ok(Math.abs(result.netPerCallUsd - 0.0089) < 1e-8);
    assert.ok(result.monthlyNetUsd > 200);
  });

  it("marks unviable when costs exceed price", () => {
    const result = estimateSellerUnitEconomics({
      priceUsd: "0.001",
      expectedDailyCalls: 10,
      costPerCallUsd: "0.002",
    });
    assert.equal(result.viable, false);
  });
});
