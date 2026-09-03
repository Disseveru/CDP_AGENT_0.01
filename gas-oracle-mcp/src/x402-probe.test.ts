import assert from "node:assert/strict";
import test from "node:test";

import { rankX402Endpoints } from "./x402-probe.js";
import { normalizeX402Receipt } from "./x402-receipt.js";

test("normalizeX402Receipt parses JSON payment-required payload", () => {
  const receipt = normalizeX402Receipt({
    paymentRequiredHeader: JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          maxAmountRequired: "5000",
          payTo: "0x1111111111111111111111111111111111111111",
          asset: "0xUSDC",
        },
      ],
    }),
    paymentResponseHeader: JSON.stringify({ success: true, txHash: "0xabc" }),
  });
  assert.equal(receipt.x402Version, 2);
  assert.equal(receipt.scheme, "exact");
  assert.equal(receipt.network, "eip155:8453");
  assert.equal(receipt.amountUsd, 0.005);
  assert.equal(receipt.txHash, "0xabc");
  assert.equal(receipt.settled, true);
});

test("normalizeX402Receipt decodes base64 headers", () => {
  const payload = Buffer.from(
    JSON.stringify({
      x402Version: "2",
      accepts: [{ scheme: "exact", network: "eip155:8453", maxAmountRequired: "1000", payTo: "0xpay" }],
    }),
  ).toString("base64");
  const receipt = normalizeX402Receipt({ paymentRequiredHeader: payload });
  assert.equal(receipt.payTo, "0xpay");
  assert.equal(receipt.amountUsd, 0.001);
});

test("rankX402Endpoints rejects empty and oversized lists", async () => {
  await assert.rejects(() => rankX402Endpoints({ urls: [] }), /non-empty array/);
  await assert.rejects(
    () =>
      rankX402Endpoints({
        urls: ["https://a.test", "https://b.test", "https://c.test", "https://d.test", "https://e.test", "https://f.test"],
      }),
    /capped at 5/,
  );
});
