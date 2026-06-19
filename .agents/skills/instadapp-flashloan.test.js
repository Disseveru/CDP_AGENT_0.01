const assert = require("node:assert/strict");
const test = require("node:test");

const DSA = require("dsa-connect");
const Web3 = require("web3");

const {
  buildFlashloanSpells,
  calculateUnitAmt,
  computeFlashPaybackAmount,
  executeFlashloanSchema,
  toTokenWei,
} = require("./instadapp-flashloan");

function createMockDsa() {
  const web3 = new Web3("https://mainnet.base.org");
  const privateKey = `0x${"11".repeat(32)}`;
  const dsa = new DSA({ web3, mode: "node", privateKey }, 8453);
  dsa.instance = {
    id: 1,
    address: "0x0000000000000000000000000000000000000001",
    version: 2,
    chainId: 8453,
  };
  return dsa;
}

test("executeFlashloanSchema accepts required flashloan inputs", () => {
  const parsed = executeFlashloanSchema.parse({
    borrowToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    borrowAmount: "10000",
    targetRoute: 1,
    targetDexAddress: "0x4e962BB388a8D756Fd596C8c8c7D2E685d6380D3",
    minReceiveAmount: "2.5",
  });

  assert.equal(parsed.targetRoute, 1);
  assert.equal(parsed.borrowAmount, "10000");
});

test("calculateUnitAmt follows Instadapp scaling formula", () => {
  const unitAmt = calculateUnitAmt(
    "500000000000000000",
    "1000000000",
    18,
    6,
  );

  assert.match(unitAmt, /^\d+$/);
  assert.equal(unitAmt, "500000000000000");
});

test("computeFlashPaybackAmount adds Instapool fee bps", () => {
  assert.equal(computeFlashPaybackAmount("1000000000"), "1000900000");
});

test("buildFlashloanSpells returns three logical spells and one cast spell", () => {
  const dsa = createMockDsa();
  const bundle = buildFlashloanSpells(dsa, {
    borrowToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    borrowAmountWei: "1000000000",
    targetRoute: 1,
    buyToken: "0x4200000000000000000000000000000000000006",
    poolFee: 500,
    unitAmt: "500000000000000000",
    paybackAmountWei: "1000900000",
  });

  assert.equal(bundle.logicalSpells.length, 3);
  assert.equal(bundle.castSpells.length, 1);
  assert.equal(bundle.logicalSpells[0].method, "flashBorrowAndCast");
  assert.equal(bundle.logicalSpells[1].connector, "UNISWAP-V3-SWAP-A");
  assert.equal(bundle.logicalSpells[2].method, "flashPayback");
  assert.equal(typeof bundle.castSpells[0].args[3], "string");
});

test("toTokenWei converts human USDC amounts", () => {
  assert.equal(toTokenWei("10000", 6), "10000000000");
  assert.equal(toTokenWei("1.5", 6), "1500000");
});
