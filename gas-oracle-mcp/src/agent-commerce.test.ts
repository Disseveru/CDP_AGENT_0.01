import assert from "node:assert/strict";
import test from "node:test";

import { parseUsdAmountForTest, usdcContract } from "./agent-commerce.js";
import { parseChainId } from "./gas-oracle.js";

test("parseUsdAmountForTest accepts dollar-prefixed quotes", () => {
  assert.equal(parseUsdAmountForTest("$0.01"), 0.01);
  assert.equal(parseUsdAmountForTest(0.25), 0.25);
});

test("parseUsdAmountForTest rejects nonsense", async () => {
  assert.throws(() => parseUsdAmountForTest("nope"), /amountUsd/);
  assert.throws(() => parseUsdAmountForTest(-1), /amountUsd/);
});

test("canonical Base USDC address is configured", () => {
  assert.equal(
    usdcContract("base")?.toLowerCase(),
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  );
});

test("commerce tools refuse base-sepolia via chain parser used by SKUs", () => {
  assert.equal(parseChainId("base"), "base");
  assert.throws(() => parseChainId("solana"), /Unsupported chain/);
});
