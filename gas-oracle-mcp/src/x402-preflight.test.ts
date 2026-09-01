import assert from "node:assert/strict";
import test from "node:test";

import {
  compareX402Sellers,
  decodePaymentRequiredPayload,
  probeX402Endpoint,
  scoreSellerHealth,
} from "./x402-preflight.js";

test("decodePaymentRequiredPayload parses JSON accepts", () => {
  const decoded = decodePaymentRequiredPayload(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          maxAmountRequired: "5000",
          payTo: "0x0000000000000000000000000000000000000001",
        },
      ],
    }),
  );
  assert.equal(decoded.rawKind, "json");
  assert.equal(decoded.accepts.length, 1);
  assert.equal(decoded.cheapestUsd, 0.005);
});

test("decodePaymentRequiredPayload parses base64 header payloads", () => {
  const json = JSON.stringify({
    x402Version: 1,
    accepts: [{ scheme: "exact", maxAmountRequired: "10000" }],
  });
  const b64 = Buffer.from(json, "utf8").toString("base64");
  const decoded = decodePaymentRequiredPayload(b64);
  assert.equal(decoded.rawKind, "base64");
  assert.equal(decoded.cheapestUsd, 0.01);
});

test("probeX402Endpoint reads 402 body and header", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: "eip155:8453", maxAmountRequired: "2000" }],
      }),
      {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": Buffer.from(
            JSON.stringify({
              x402Version: 2,
              accepts: [{ scheme: "exact", maxAmountRequired: "2000" }],
            }),
          ).toString("base64"),
        },
      },
    );
  try {
    const probe = await probeX402Endpoint({ url: "https://example.com/paid" });
    assert.equal(probe.httpStatus, 402);
    assert.equal(probe.paymentRequired, true);
    assert.equal(probe.headerPresent, true);
    assert.equal(probe.accepts.length, 1);
    assert.equal(probe.cheapestUsd, 0.002);
    const health = scoreSellerHealth(probe);
    assert.ok(health.score >= 70);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("compareX402Sellers ranks live quotes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    const amount = url.includes("cheap") ? "1000" : "9000";
    return new Response(JSON.stringify({ accepts: [{ maxAmountRequired: amount }] }), { status: 402 });
  };
  try {
    const result = await compareX402Sellers({
      urls: ["https://example.com/cheap", "https://example.com/dear"],
    });
    assert.equal(result.liveCount, 2);
    assert.equal(result.cheapestLive?.url, "https://example.com/cheap");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeX402Endpoint rejects private URLs", async () => {
  await assert.rejects(() => probeX402Endpoint({ url: "http://127.0.0.1/admin" }), /Blocked|private/i);
});
