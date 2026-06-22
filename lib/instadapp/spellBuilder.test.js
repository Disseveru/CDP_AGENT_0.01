const assert = require("node:assert/strict");
const test = require("node:test");

const { computeUnitAmt } = require("./quoter");
const { substituteTemplate } = require("./spellBuilder");

test("substituteTemplate replaces placeholders", () => {
  const result = substituteTemplate("{{amount}}", { amount: "42" });
  assert.equal(result, "42");
});

test("substituteTemplate resolves nested arrays", () => {
  const result = substituteTemplate(["{{token}}", "{{amount}}"], {
    token: "0xabc",
    amount: "100",
  });
  assert.deepEqual(result, ["0xabc", "100"]);
});

test("computeUnitAmt applies slippage buffer", () => {
  const unit = computeUnitAmt(1_000_000n, 2_000_000n);
  assert.ok(BigInt(unit) < 2n * 10n ** 18n);
  assert.ok(BigInt(unit) > 19n * 10n ** 17n);
});
