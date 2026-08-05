import assert from "node:assert/strict";
import test from "node:test";

import {
  getGasOracle,
  getGasOracleBatch,
  estimateTxCost,
  listSupportedChains,
  parseChainId,
} from "./gas-oracle.js";

test("listSupportedChains includes base and ethereum", () => {
  const chains = listSupportedChains();
  const ids = chains.map((c) => c.id);
  assert.ok(ids.includes("base"));
  assert.ok(ids.includes("ethereum"));
  assert.ok(ids.includes("arbitrum"));
});

test("parseChainId rejects unknown chains", () => {
  assert.throws(() => parseChainId("solana"), /Unsupported chain/);
  assert.throws(() => parseChainId(42), /chain must be/);
});

test("parseChainId accepts known chains", () => {
  assert.equal(parseChainId("base"), "base");
  assert.equal(parseChainId("Ethereum"), "ethereum");
});

test("getGasOracle returns structured fees for base", async () => {
  const result = await getGasOracle("base");
  assert.equal(result.chain, "base");
  assert.equal(result.chainId, 8453);
  assert.ok(Number(result.gasPriceGwei) >= 0);
  assert.ok(Number(result.eip1559.standard.maxFeeGwei) > 0);
  assert.ok(result.estimates.nativeTransfer.gasLimit === "21000");
  assert.ok(typeof result.nativeUsdPrice === "number");
  assert.ok(result.blockNumber);
  assert.ok(result.timestamp);
});

test("getGasOracle uses cache on second call", async () => {
  const first = await getGasOracle("base");
  const second = await getGasOracle("base");
  assert.equal(second.cached, true);
  assert.equal(first.blockNumber, second.blockNumber);
});

test("getGasOracleBatch returns multiple chains", async () => {
  const { results, errors } = await getGasOracleBatch(["base", "optimism"]);
  assert.ok(results.length >= 1);
  for (const r of results) {
    assert.ok(["base", "optimism"].includes(r.chain));
  }
  // errors may be empty or contain failed chains; just ensure shape
  assert.equal(typeof errors, "object");
});

test("estimateTxCost validates gasLimit", async () => {
  await assert.rejects(() => estimateTxCost({ chain: "base", gasLimit: 0 }), /gasLimit/);
  await assert.rejects(
    () => estimateTxCost({ chain: "base", gasLimit: 50_000_000 }),
    /gasLimit/,
  );
});

test("estimateTxCost returns cost for custom limit", async () => {
  const result = await estimateTxCost({ chain: "base", gasLimit: 100_000 });
  assert.equal(result.chain, "base");
  assert.equal(result.gasLimit, "100000");
  assert.ok(Number(result.costUsd) >= 0);
});
