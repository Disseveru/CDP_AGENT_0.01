import assert from "node:assert/strict";
import test from "node:test";

import {
  planShopBudget,
  rankTrueCostShop,
  settlementOverheadUsd,
} from "./true-cost-shop.js";

test("Base settlement overhead is cheaper than Ethereum", () => {
  assert.ok(settlementOverheadUsd("eip155:8453") < settlementOverheadUsd("eip155:1"));
  assert.equal(settlementOverheadUsd("base"), settlementOverheadUsd("eip155:8453"));
});

test("rankTrueCostShop prefers listed-cheap L2 over cheaper L1 after overhead", () => {
  const result = rankTrueCostShop([
    { name: "eth-data", network: "eip155:1", listedUsd: "0.01" },
    { name: "base-data", network: "eip155:8453", listedUsd: "0.02" },
  ]);
  assert.equal(result.cheapest?.name, "base-data");
  assert.ok((result.cheapest?.trueCostUsd ?? 1) < 0.03);
  assert.match(result.recommendation, /base-data/);
});

test("retries inflate true cost", () => {
  const result = rankTrueCostShop([
    { name: "flaky", network: "base", listedUsd: 0.01, expectedRetries: 3 },
    { name: "stable", network: "base", listedUsd: 0.02, expectedRetries: 1 },
  ]);
  assert.equal(result.cheapest?.name, "stable");
});

test("bestValue prefers proven demand at similar price", () => {
  const result = rankTrueCostShop([
    { name: "ghost", network: "base", listedUsd: "0.01", uniquePayers30d: 0, calls30d: 0 },
    { name: "exa", network: "base", listedUsd: "0.01", uniquePayers30d: 81, calls30d: 5879 },
  ]);
  assert.equal(result.bestValue?.name, "exa");
  assert.ok((result.bestValue?.demandScore ?? 0) > 0);
});

test("planShopBudget computes affordable calls", () => {
  const plan = planShopBudget({
    balanceUsd: "1.00",
    reserveUsd: "0.10",
    cheapestTrueCostUsd: "0.02",
  });
  assert.equal(plan.spendableUsd, 0.9);
  assert.equal(plan.maxCalls, 45);
});

test("rejects empty listings and bad retries", () => {
  assert.throws(() => rankTrueCostShop([]), /1-25/);
  assert.throws(
    () => rankTrueCostShop([{ name: "x", network: "base", listedUsd: 0.01, expectedRetries: 9 }]),
    /expectedRetries/,
  );
});
