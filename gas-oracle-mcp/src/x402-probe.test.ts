import assert from "node:assert/strict";
import test from "node:test";

import { decodePaymentRequiredPayload, probeX402Endpoint, quoteX402Bundle } from "./x402-probe.js";

test("decodePaymentRequiredPayload reads v2 base64 header", () => {
  const payload = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        payTo: "0x0000000000000000000000000000000000000001",
        asset: "USDC",
        price: "$0.012",
        resource: "https://seller.example/tool",
      },
      {
        scheme: "exact",
        network: "eip155:8453",
        payTo: "0x0000000000000000000000000000000000000001",
        maxAmountRequired: "25000",
      },
    ],
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const decoded = decodePaymentRequiredPayload(encoded);
  assert.equal(decoded.decoded, true);
  assert.equal(decoded.x402Version, 2);
  assert.equal(decoded.accepts.length, 2);
  assert.equal(decoded.cheapest?.priceUsd, 0.012);
});

test("decodePaymentRequiredPayload treats atomic USDC units as 6 decimals", () => {
  const decoded = decodePaymentRequiredPayload({
    accepts: [{ scheme: "exact", maxAmountRequired: "1000", network: "eip155:8453" }],
  });
  assert.equal(decoded.cheapest?.priceUsd, 0.001);
});

test("decodePaymentRequiredPayload handles empty input", () => {
  const decoded = decodePaymentRequiredPayload("");
  assert.equal(decoded.decoded, false);
  assert.equal(decoded.source, "none");
});

test("probeX402Endpoint decodes 402 headers", async () => {
  const payload = {
    x402Version: 2,
    accepts: [{ scheme: "exact", network: "eip155:8453", price: "$0.005", payTo: "0xabc" }],
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("payment required", {
      status: 402,
      headers: { "PAYMENT-REQUIRED": encoded },
    });

  try {
    const result = await probeX402Endpoint({ url: "https://example.com/paid" });
    assert.equal(result.status, 402);
    assert.equal(result.paymentRequired, true);
    assert.equal(result.decode.cheapest?.priceUsd, 0.005);
    assert.match(result.recommendation, /Pay 0.005000 USDC/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeX402Endpoint rejects non GET/HEAD", async () => {
  await assert.rejects(
    () => probeX402Endpoint({ url: "https://example.com", method: "POST" }),
    /GET or HEAD/,
  );
});

test("quoteX402Bundle ranks cheapest paid endpoint", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    const price = url.includes("cheap") ? "$0.002" : "$0.020";
    const encoded = Buffer.from(
      JSON.stringify({ accepts: [{ scheme: "exact", price, network: "eip155:8453" }] }),
      "utf8",
    ).toString("base64");
    return new Response("", { status: 402, headers: { "payment-required": encoded } });
  };

  try {
    const bundle = await quoteX402Bundle({
      urls: ["https://example.com/expensive", "https://example.com/cheap"],
    });
    assert.equal(bundle.count, 2);
    assert.equal(bundle.cheapestPaid?.decode.cheapest?.priceUsd, 0.002);
    assert.match(bundle.cheapestPaid?.url ?? "", /cheap/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("quoteX402Bundle rejects oversized lists", async () => {
  await assert.rejects(
    () =>
      quoteX402Bundle({
        urls: ["https://a.com", "https://b.com", "https://c.com", "https://d.com", "https://e.com"],
      }),
    /at most 4/,
  );
});
