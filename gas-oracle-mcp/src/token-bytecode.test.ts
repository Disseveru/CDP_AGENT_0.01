import assert from "node:assert/strict";
import test from "node:test";

import { analyzeTokenBytecode } from "./token-bytecode.js";

test("empty bytecode is unknown/high risk", () => {
  const report = analyzeTokenBytecode({
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    bytecode: "0x",
  });
  assert.equal(report.verdict, "unknown");
  assert.equal(report.flags.isEmpty, true);
  assert.ok(report.riskScore >= 80);
});

test("selfdestruct flag raises score", () => {
  const report = analyzeTokenBytecode({
    token: "0x833589fCD6eDb6E08f4C7C32D4f71b54bdA02913",
    bytecode: "0x6000ff",
  });
  assert.equal(report.flags.hasSelfdestruct, true);
  assert.ok(report.riskScore >= 35);
});

test("rejects invalid address", () => {
  assert.throws(() => analyzeTokenBytecode({ token: "not-an-address", bytecode: "0x00" }));
});
