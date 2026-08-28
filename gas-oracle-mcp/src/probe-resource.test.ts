import assert from "node:assert/strict";
import test from "node:test";

import { probeResource } from "./probe-resource.js";

test("probeResource rejects private hosts", async () => {
  const result = await probeResource({ url: "http://127.0.0.1/" });
  assert.equal(result.reachable, false);
  assert.equal(result.dead, true);
  assert.ok(result.error);
});

test("probeResource detects 402 payment envelope", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "10000",
            asset: "0xUSDC",
            payTo: "0xabc",
            maxTimeoutSeconds: 60,
          },
        ],
      }),
      { status: 402, headers: { "content-type": "application/json" } },
    );

  try {
    const result = await probeResource({ url: "https://example.com/paid" });
    assert.equal(result.reachable, true);
    assert.equal(result.paymentRequired, true);
    assert.equal(result.freeAccess, false);
    assert.equal(result.dead, false);
    assert.equal(result.accepts.length, 1);
    assert.equal(result.accepts[0].network, "eip155:8453");
    assert.equal(result.accepts[0].amount, "10000");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeResource marks 404 as dead", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("gone", { status: 404 });

  try {
    const result = await probeResource({ url: "https://example.com/missing" });
    assert.equal(result.dead, true);
    assert.equal(result.paymentRequired, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeResource marks free 200 as freeAccess", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const result = await probeResource({ url: "https://example.com/free" });
    assert.equal(result.freeAccess, true);
    assert.equal(result.paymentRequired, false);
    assert.equal(result.dead, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
