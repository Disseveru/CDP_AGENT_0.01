import assert from "node:assert/strict";
import { test } from "node:test";

import {
  issueDeliveryReceipt,
  planFacilitatorFailover,
  screenTokenAllowlist,
  verifyDeliveryReceipt,
} from "./commerce-trust.js";

test("issues and verifies a delivery receipt", () => {
  const receipt = issueDeliveryReceipt({
    resource: "https://seller.example/sku/gas",
    buyer: "0x1111111111111111111111111111111111111111",
    seller: "0x2222222222222222222222222222222222222222",
    amountUsd: "$0.005",
    content: { ok: true },
    secret: "unit-secret",
  });
  assert.equal(receipt.schema, "agentwire.delivery-receipt.v1");
  assert.equal(receipt.amountUsd, "0.005");
  const check = verifyDeliveryReceipt(receipt, "unit-secret");
  assert.equal(check.valid, true);
  const bad = verifyDeliveryReceipt({ ...receipt, signature: "aa".repeat(32) }, "unit-secret");
  assert.equal(bad.valid, false);
});

test("screens Base USDC as pay and unknown tokens as refuse", () => {
  const usdc = screenTokenAllowlist({
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    chain: "base",
  });
  assert.equal(usdc.recommendation, "pay");
  assert.equal(usdc.symbol, "USDC");
  const junk = screenTokenAllowlist({
    token: "0x000000000000000000000000000000000000dead",
    chain: "base",
  });
  assert.equal(junk.recommendation, "refuse");
});

test("plans facilitator failover from mock probes", async () => {
  const plan = await planFacilitatorFailover(
    {
      facilitators: [
        { id: "down", url: "https://down.example/x402", feeBps: 0 },
        { id: "live", url: "https://live.example/x402", feeBps: 10 },
      ],
      timeoutMs: 500,
    },
    async (url) => {
      if (String(url).includes("down")) throw new Error("connect_timeout");
      return new Response("ok", { status: 200 });
    },
  );
  assert.equal(plan.primary?.id, "live");
  assert.deepEqual(plan.failoverOrder, ["live"]);
});
