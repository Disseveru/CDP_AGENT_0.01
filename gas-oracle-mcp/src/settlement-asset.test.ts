import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeX402Amount,
  screenSettlementAsset,
  settlementReadiness,
} from "./settlement-asset.js";

test("screenSettlementAsset allows native Base USDC", () => {
  const result = screenSettlementAsset({
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    network: "base",
  });
  assert.equal(result.allowed, true);
  assert.equal(result.matched?.caip2, "eip155:8453");
});

test("screenSettlementAsset rejects unknown ERC-20", () => {
  const result = screenSettlementAsset({
    asset: "0x0000000000000000000000000000000000000001",
    network: "base",
  });
  assert.equal(result.allowed, false);
});

test("normalizeX402Amount converts USD to 6-decimal atomic", () => {
  const result = normalizeX402Amount({ amountUsd: "0.002" });
  assert.equal(result.atomic, "2000");
});

test("normalizeX402Amount parses atomic back to USD", () => {
  const result = normalizeX402Amount({ atomic: "2000" });
  assert.equal(result.amountUsd, 0.002);
});

test("settlementReadiness is ready only when asset payee and amount pass", () => {
  const ok = settlementReadiness({
    payTo: "0x0000000000000000000000000000000000000002",
    asset: "USDC",
    network: "base",
    amountUsd: "0.01",
    maxPriceUsd: "0.05",
  });
  assert.equal(ok.ready, true);
  assert.equal(ok.amount.atomic, "10000");

  const bad = settlementReadiness({
    payTo: "0x0000000000000000000000000000000000000002",
    asset: "FAKE",
    amountUsd: "0.01",
  });
  assert.equal(bad.ready, false);
});
