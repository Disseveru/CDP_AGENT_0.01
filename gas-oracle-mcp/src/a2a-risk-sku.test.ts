import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeTokenRisk,
  classifyFacilitatorSettle,
  planOnchainSlaEscrow,
  pollFacilitatorSettle,
} from "./a2a-risk-sku.js";

test("analyzeTokenRisk rejects stablecoin name spoof", () => {
  const result = analyzeTokenRisk({
    token: "0x0000000000000000000000000000000000000001",
    symbol: "USDC",
    decimals: 6,
  });
  assert.equal(result.recommendation, "reject");
  assert.ok(result.findings.some((f) => f.code === "stable_name_spoof"));
});

test("analyzeTokenRisk flags missing ERC-20 selectors", () => {
  const result = analyzeTokenRisk({
    token: "0x0000000000000000000000000000000000000002",
    bytecodeHex: "0x6080604052",
  });
  assert.equal(result.recommendation, "reject");
  assert.ok(result.findings.some((f) => f.code === "missing_erc20_selectors"));
});

test("classifyFacilitatorSettle V2 pending vs terminal", () => {
  const pending = classifyFacilitatorSettle({ success: false, transaction: "0xabc" }, "v2");
  assert.equal(pending.outcome, "pending");
  assert.equal(pending.shouldPollAgain, true);

  const failed = classifyFacilitatorSettle({ success: false, transaction: "" }, "v2");
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.shouldPollAgain, false);

  const settled = classifyFacilitatorSettle({ success: true, transaction: "0xdef" }, "v2");
  assert.equal(settled.outcome, "settled");
});

test("pollFacilitatorSettle posts JSON and classifies body", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ success: false, transaction: "0x1" }), { status: 200 })) as typeof fetch;
  const result = await pollFacilitatorSettle({
    facilitatorUrl: "https://facilitator.example/settle",
    fetchImpl: fakeFetch,
  });
  assert.equal(result.outcome, "pending");
  assert.equal(result.httpStatus, 200);
});

test("planOnchainSlaEscrow sizes hold and rejects same-party", () => {
  const plan = planOnchainSlaEscrow({
    buyer: "0x0000000000000000000000000000000000000001",
    seller: "0x0000000000000000000000000000000000000002",
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    serviceUsd: "2.00",
    slaHours: 4,
    penaltyBps: 250,
  });
  assert.equal(plan.holdUsd, 2.5);
  assert.equal(plan.slaSeconds, 14400);
  assert.throws(() =>
    planOnchainSlaEscrow({
      buyer: "0x0000000000000000000000000000000000000001",
      seller: "0x0000000000000000000000000000000000000001",
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      serviceUsd: "1",
      slaHours: 1,
    }),
  );
});
