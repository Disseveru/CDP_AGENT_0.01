import assert from "node:assert/strict";
import test from "node:test";

import { decodePaymentRequired } from "./x402-commerce.js";
import { planAgentSpend } from "./agent-commerce.js";

test("decodePaymentRequired reads JSON accepts", () => {
  const result = decodePaymentRequired({
    payload: {
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x0000000000000000000000000000000000000001",
          maxAmountRequired: "5000",
        },
      ],
      resource: "mcp://tool/quote_gas",
      description: "gas quote",
    },
  });
  assert.equal(result.decoded, true);
  assert.equal(result.source, "object");
  assert.equal(result.accepts.length, 1);
  assert.equal(result.accepts[0].scheme, "exact");
  assert.equal(result.accepts[0].payTo, "0x0000000000000000000000000000000000000001");
  assert.match(result.recommendation, /Decoded 1/);
});

test("decodePaymentRequired reads base64 PAYMENT-REQUIRED header", () => {
  const json = JSON.stringify({
    accepts: [{ scheme: "exact", network: "base", payTo: "0xabc", maxAmountRequired: "$0.002" }],
  });
  const header = Buffer.from(json, "utf8").toString("base64");
  const result = decodePaymentRequired({ payload: header });
  assert.equal(result.source, "header");
  assert.equal(result.accepts[0].maxAmountRequired, "$0.002");
});

test("decodePaymentRequired rejects empty payload", () => {
  assert.throws(() => decodePaymentRequired({ payload: "" }), /required/);
});

test("decodePaymentRequired flags missing options", () => {
  const result = decodePaymentRequired({ payload: { description: "no pays" } });
  assert.equal(result.decoded, false);
  assert.match(result.recommendation, /No payment options/);
});

test("atomic USDC amount can feed planAgentSpend", () => {
  const plan = planAgentSpend({
    balanceUsd: "1",
    pricePerCallUsd: 5000 / 1_000_000,
    reserveUsd: "0",
    maxCalls: 1,
  });
  assert.equal(plan.canAffordAtLeastOne, true);
  assert.equal(plan.plannedSpendUsd, 0.005);
});
