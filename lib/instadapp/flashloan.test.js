const assert = require("node:assert/strict");
const test = require("node:test");

const { withFlashPayback } = require("./flashloan");
const { applyFlashloanFee } = require("./protocols");

test("applyFlashloanFee adds default 9 bps premium", () => {
  assert.equal(applyFlashloanFee("1000000").toString(), "1000900");
});

test("withFlashPayback appends INSTAPOOL-C flashPayback", () => {
  const inner = [
    {
      connector: "SWAP-AGGREGATOR-A",
      method: "sell",
      args: ["0x01", "0x02", 500, "1", "1000", 0, 0],
    },
  ];

  const spells = withFlashPayback(inner, {
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amountWei: "1000000",
  });

  assert.equal(spells.length, 2);
  assert.equal(spells[1].connector, "INSTAPOOL-C");
  assert.equal(spells[1].method, "flashPayback");
  assert.equal(spells[1].args[1], "1000900");
});

test("withFlashPayback preserves existing payback spell", () => {
  const inner = [
    {
      connector: "INSTAPOOL-C",
      method: "flashPayback",
      args: ["0x01", "123", 0, 0],
    },
  ];

  const spells = withFlashPayback(inner, {
    token: "0x01",
    amountWei: "1000",
  });

  assert.equal(spells.length, 1);
});
