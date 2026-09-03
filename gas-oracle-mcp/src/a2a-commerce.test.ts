import assert from "node:assert/strict";
import test from "node:test";

import { parseX402Challenge, scoreAddressLookalike, probeX402Resource } from "./a2a-commerce.js";

test("parseX402Challenge reads accepts array", () => {
  const parsed = parseX402Challenge({
    body: {
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x0000000000000000000000000000000000000001",
          maxAmountRequired: "5000",
        },
      ],
    },
  });
  assert.equal(parsed.paymentRequired, true);
  assert.equal(parsed.accepts.length, 1);
  assert.equal(parsed.accepts[0].scheme, "exact");
  assert.equal(parsed.accepts[0].payTo, "0x0000000000000000000000000000000000000001");
});

test("parseX402Challenge reads PAYMENT-REQUIRED header", () => {
  const parsed = parseX402Challenge({
    paymentRequiredHeader: JSON.stringify({
      scheme: "exact",
      network: "eip155:8453",
      maxAmountRequired: "1000",
    }),
  });
  assert.equal(parsed.paymentRequired, true);
  assert.equal(parsed.accepts[0].maxAmountRequired, "1000");
});

test("scoreAddressLookalike flags shared prefix and suffix", () => {
  const expected = "0x1111111111111111111111111111111111111111";
  const actual = "0x11111111aaaaaaaaaaaaaaaaaaaaaa1111111111";
  const score = scoreAddressLookalike({ expected, actual });
  assert.equal(score.same, false);
  assert.equal(score.risk, "high");
});

test("scoreAddressLookalike matches identical addresses", () => {
  const addr = "0x0000000000000000000000000000000000000001";
  const score = scoreAddressLookalike({ expected: addr, actual: addr });
  assert.equal(score.same, true);
  assert.equal(score.risk, "none");
});

test("probeX402Resource blocks localhost", async () => {
  const result = await probeX402Resource({ url: "http://127.0.0.1/" });
  assert.equal(result.paymentRequired, false);
  assert.match(String(result.error), /Blocked|private|Invalid/i);
});
