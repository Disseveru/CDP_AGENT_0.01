import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkFacilitatorHealth,
  sanitizeQuery,
  searchAgenticMarket,
  type FetchLike,
} from "./agentic-discovery.js";

describe("sanitizeQuery", () => {
  it("rejects empty", () => {
    assert.throws(() => sanitizeQuery("   "), /non-empty/);
  });
  it("trims and caps length", () => {
    assert.equal(sanitizeQuery("  gas  "), "gas");
    assert.equal(sanitizeQuery("x".repeat(200)).length, 80);
  });
});

describe("searchAgenticMarket", () => {
  it("maps catalog JSON to summaries", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          services: [
            {
              id: "exa",
              name: "Exa",
              description: "AI search",
              category: "Search",
              networks: ["base"],
              endpoints: [{ pricing: { amount: "0.003", currency: "USDC" } }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const out = await searchAgenticMarket({ q: "search", limit: 5 }, { fetchImpl });
    assert.equal(out.count, 1);
    assert.equal(out.services[0]?.id, "exa");
    assert.equal(out.services[0]?.minPriceUsd, "0.003");
  });

  it("throws on HTTP error", async () => {
    const fetchImpl: FetchLike = async () => new Response("nope", { status: 503 });
    await assert.rejects(() => searchAgenticMarket({ q: "x" }, { fetchImpl }), /503/);
  });
});

describe("checkFacilitatorHealth", () => {
  it("marks https 200 as ok and rejects http", async () => {
    const fetchImpl: FetchLike = async () => new Response("{}", { status: 200 });
    const out = await checkFacilitatorHealth(
      {
        urls: [
          { id: "ok", url: "https://facilitator.example" },
          { id: "bad", url: "http://facilitator.example" },
        ],
      },
      { fetchImpl },
    );
    assert.equal(out.facilitators[0]?.ok, true);
    assert.equal(out.facilitators[1]?.ok, false);
    assert.match(String(out.facilitators[1]?.error), /https/);
  });
});
