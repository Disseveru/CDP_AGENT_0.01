const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BASE_MAINNET,
  BASE_TOKENS,
  calculateUnitAmt,
  resolveBaseMainnetRpcUrl,
  toTokenWei,
} = require("./blockchain-data");

test("BASE_MAINNET matches Base docs connecting-to-base values", () => {
  assert.equal(BASE_MAINNET.chainId, 8453);
  assert.equal(BASE_MAINNET.rpcUrl, "https://mainnet.base.org");
  assert.equal(BASE_MAINNET.docsIndex, "https://docs.base.org/llms.txt");
});

test("BASE_TOKENS includes canonical USDC and WETH on Base", () => {
  assert.equal(BASE_TOKENS.USDC, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(BASE_TOKENS.WETH, "0x4200000000000000000000000000000000000006");
});

test("resolveBaseMainnetRpcUrl prefers DSA_RPC_URL", () => {
  const previous = process.env.DSA_RPC_URL;
  process.env.DSA_RPC_URL = "https://custom.base.rpc";

  try {
    assert.equal(resolveBaseMainnetRpcUrl(), "https://custom.base.rpc");
  } finally {
    if (previous === undefined) {
      delete process.env.DSA_RPC_URL;
    } else {
      process.env.DSA_RPC_URL = previous;
    }
  }
});

test("calculateUnitAmt matches Instadapp FAQ scaling", () => {
  assert.equal(
    calculateUnitAmt("500000000000000000", "1000000000", 18, 6),
    "500000000000000",
  );
});

test("toTokenWei converts fractional stablecoin amounts", () => {
  assert.equal(toTokenWei("1.25", 6), "1250000");
});
