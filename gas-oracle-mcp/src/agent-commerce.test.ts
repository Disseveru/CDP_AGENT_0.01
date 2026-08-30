import assert from "node:assert/strict";
import test from "node:test";

import { parseUsdAmount, planAgentSpend } from "./agent-commerce.js";

test("parseUsdAmount accepts $ and plain decimals", () => {
  assert.equal(parseUsdAmount("$0.005", "price"), 0.005);
  assert.equal(parseUsdAmount("1.25", "price"), 1.25);
  assert.equal(parseUsdAmount(2, "price"), 2);
});

test("parseUsdAmount rejects garbage", () => {
  assert.throws(() => parseUsdAmount("free", "price"), /must be a non-negative USD amount/);
  assert.throws(() => parseUsdAmount(-1, "price"), /must be a non-negative USD amount/);
});

test("planAgentSpend computes affordable call count and reserve", () => {
  const plan = planAgentSpend({
    balanceUsd: "1.00",
    pricePerCallUsd: "$0.25",
    reserveUsd: "0.10",
    maxCalls: 10,
  });
  assert.equal(plan.spendableUsd, 0.9);
  assert.equal(plan.maxAffordableCalls, 3);
  assert.equal(plan.plannedCalls, 3);
  assert.equal(plan.canAffordAtLeastOne, true);
  assert.match(plan.recommendation, /Buy 3/);
});

test("planAgentSpend refuses spend at reserve floor", () => {
  const plan = planAgentSpend({
    balanceUsd: "0.05",
    pricePerCallUsd: "0.25",
    reserveUsd: "0.05",
  });
  assert.equal(plan.canAffordAtLeastOne, false);
  assert.match(plan.recommendation, /Do not buy/);
});

test("planAgentSpend rejects zero price", () => {
  assert.throws(
    () => planAgentSpend({ balanceUsd: 1, pricePerCallUsd: 0 }),
    /greater than 0/,
  );
});
