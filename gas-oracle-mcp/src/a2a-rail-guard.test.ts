import assert from "node:assert/strict";
import test from "node:test";

import {
  probeFacilitatorsLive,
  screenAsset,
  settlementEconomics,
} from "./a2a-rail-guard.js";

test("screenAsset accepts Base USDC and rejects unknown when required", () => {
  const usdc = screenAsset({
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    chainId: "eip155:8453",
    requireKnownStable: true,
  });
  assert.equal(usdc.allowed, true);
  assert.equal(usdc.knownStable, true);
  assert.equal(usdc.symbol, "USDC");

  const junk = screenAsset({
    token: "0x0000000000000000000000000000000000000001",
    requireKnownStable: true,
  });
  assert.equal(junk.allowed, false);
});

test("settlementEconomics adds listed + gas + fee and picks cheapest chain", () => {
  const quote = settlementEconomics({
    listedPriceUsd: "0.010",
    estimatedGasUsd: "0.0015",
    facilitatorFeeUsd: "0.001",
    chains: [
      { name: "base", gasUsd: "0.0015" },
      { name: "solana", gasUsd: "0.0002" },
    ],
  });
  assert.equal(quote.allInUsd, 0.0125);
  assert.equal(quote.cheapestChain, "solana");
});

test("probeFacilitatorsLive ranks a live mock facilitator first", async () => {
  const fetchImpl = async (url: string) => {
    if (url.includes("down")) return { ok: false, status: 503 };
    return { ok: true, status: 200 };
  };
  const result = await probeFacilitatorsLive(
    [
      { name: "down", url: "https://down.example/supported" },
      { name: "up", url: "https://up.example/supported" },
    ],
    500,
    fetchImpl,
  );
  assert.equal(result.selected?.name, "up");
  assert.match(result.recommendation, /up/);
});
