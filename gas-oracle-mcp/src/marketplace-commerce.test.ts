import assert from "node:assert/strict";
import test from "node:test";

import { probeX402Endpoint, rankAgenticSellers } from "./marketplace-commerce.js";

test("probeX402Endpoint rejects private hosts", async () => {
  await assert.rejects(() => probeX402Endpoint({ url: "http://127.0.0.1/x402" }), /Blocked/);
});

test("probeX402Endpoint rejects credentialed URLs", async () => {
  await assert.rejects(
    () => probeX402Endpoint({ url: "https://user:pass@example.com/pay" }),
    /credentials/,
  );
});

test("rankAgenticSellers rejects short queries", async () => {
  await assert.rejects(() => rankAgenticSellers({ query: "a" }), /2-80/);
});

test("rankAgenticSellers maps marketplace payload", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        services: [
          {
            id: "api-exa-ai",
            name: "Exa",
            category: "Search",
            description: "AI search",
            networks: ["Base"],
            priceSummary: { minAmount: "0.001", maxAmount: "0.007", currency: "USDC" },
            endpoints: [
              {
                url: "https://api.exa.ai/search",
                method: "POST",
                description: "Search",
                pricing: { amount: "0.007" },
                quality: { l30DaysTotalCalls: "10", l30DaysUniquePayers: "3" },
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    const result = await rankAgenticSellers({ query: "search", limit: 5 });
    assert.equal(result.count, 1);
    assert.equal(result.cheapest?.name, "Exa");
    assert.equal(result.hottest?.calls30d, 10);
    assert.equal(result.sellers[0].endpoints[0].method, "POST");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
