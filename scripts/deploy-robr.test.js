const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PaymasterSubmitError,
  shouldFallbackToAvocado,
} = require("./deploy-robr");

test("shouldFallbackToAvocado allows fallback before paymaster submission", () => {
  assert.equal(shouldFallbackToAvocado(new Error("missing CDP credentials")), true);
  assert.equal(shouldFallbackToAvocado(new Error("Paymaster URL lookup failed (401)")), true);
});

test("shouldFallbackToAvocado blocks fallback after paymaster user op submission", () => {
  const error = new PaymasterSubmitError("receipt timeout", "0xuserop");
  assert.equal(shouldFallbackToAvocado(error), false);
  assert.equal(error.userOpHash, "0xuserop");
  assert.equal(error.paymasterUserOpSubmitted, true);
});
