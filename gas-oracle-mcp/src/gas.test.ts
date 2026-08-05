import assert from "node:assert/strict";
import test from "node:test";

import {
  _resetGasClientCache,
  getBalance,
  getGasOracle,
  getTxStatus,
} from "./gas.js";

test.afterEach(() => {
  _resetGasClientCache();
});

test("getGasOracle rejects unknown networks", async () => {
  await assert.rejects(() => getGasOracle({ network: "solana" }), /Unsupported network/);
});

test("getBalance rejects invalid addresses", async () => {
  await assert.rejects(() => getBalance({ address: "not-an-address" }), /Invalid address/);
});

test("getTxStatus rejects invalid hashes", async () => {
  await assert.rejects(() => getTxStatus({ hash: "0xdead" }), /Invalid transaction hash/);
});

test("getGasOracle returns base snapshot shape (live RPC)", async () => {
  const result = await getGasOracle({ network: "base" });
  assert.ok(result.timestamp);
  assert.equal(result.networks.length, 1);
  const row = result.networks[0];
  assert.equal(row.network, "base");
  assert.equal(row.chainId, 8453);
  assert.ok(row.fetchedInMs >= 0);
  if (!row.error) {
    assert.ok(Number(row.gasPriceGwei) >= 0);
    assert.ok(Number(row.blockNumber) > 0);
  }
});

test("getBalance reads zero address on base (live RPC)", async () => {
  const result = await getBalance({
    address: "0x0000000000000000000000000000000000000000",
    network: "base",
  });
  assert.equal(result.network, "base");
  assert.equal(result.symbol, "ETH");
  assert.equal(result.decimals, 18);
  assert.ok(result.balanceWei !== undefined);
  assert.ok(Number(result.balance) >= 0);
});

test("getTxStatus returns not_found for unknown hash on base (live RPC)", async () => {
  const result = await getTxStatus({
    hash: "0x0000000000000000000000000000000000000000000000000000000000000001",
    network: "base",
  });
  assert.equal(result.network, "base");
  assert.equal(result.status, "not_found");
  assert.equal(result.blockNumber, null);
});
