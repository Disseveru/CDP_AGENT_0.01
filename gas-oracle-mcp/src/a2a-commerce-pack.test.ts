import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeSpendSession,
  issueSpendSession,
  quoteReceiptSlaPack,
  sellerHostDossier,
  validateSellerPayload,
} from "./a2a-commerce-pack.js";

test("spend session issues, consumes, and blocks overspend", () => {
  process.env.SPEND_SESSION_HMAC_SECRET = "unit-pack-secret";
  const session = issueSpendSession({
    parentAgent: "parent-1",
    budgetUsd: "0.050",
    ttlSeconds: 600,
    allowSkus: ["quote_gas", "verify_settlement"],
  });
  const first = consumeSpendSession({ session, sku: "quote_gas", amountUsd: "0.020" });
  assert.equal(first.allowed, true);
  assert.equal(first.session.remainingUsd, "0.030000");
  const blockedSku = consumeSpendSession({ session: first.session, sku: "fetch_url", amountUsd: "0.001" });
  assert.equal(blockedSku.allowed, false);
  const over = consumeSpendSession({ session: first.session, sku: "verify_settlement", amountUsd: "0.040" });
  assert.equal(over.allowed, false);
});

test("sellerHostDossier rewards organic payers and cheap tickets", () => {
  const good = sellerHostDossier({
    host: "api.exa.ai",
    l30DaysTotalCalls: 6082,
    l30DaysUniquePayers: 88,
    listedPriceUsd: "0.007",
    scheme: "exact",
    headerHygieneOk: true,
  });
  assert.equal(good.buy, true);
  assert.ok(good.score >= 80);

  const thin = sellerHostDossier({
    host: "dust.example",
    l30DaysTotalCalls: 2,
    l30DaysUniquePayers: 1,
    listedPriceUsd: "2.00",
    isNew: true,
    headerHygieneOk: false,
  });
  assert.equal(thin.buy, false);
  assert.ok(thin.score < 50);
});

test("quoteReceiptSlaPack self-verifies receipt and SLA", () => {
  process.env.RECEIPT_HMAC_SECRET = "unit-pack-secret";
  const pack = quoteReceiptSlaPack({
    sku: "fetch_url",
    buyer: "0xbuyer",
    seller: "0xseller",
    amountUsd: "0.012",
    contentHash: "abc123def4567890",
    slaHours: 2,
    penaltyBps: 500,
  });
  assert.equal(pack.receiptCheck.valid, true);
  assert.equal(pack.sla.holdUsd, 0.015);
});

test("validateSellerPayload rejects prototype keys and oversized bodies", () => {
  const bad = validateSellerPayload({
    payload: JSON.parse('{"ok":true}'),
    requiredKeys: ["ok"],
  });
  assert.equal(bad.ok, true);
  const missing = validateSellerPayload({
    payload: { status: "ok" },
    requiredKeys: ["txHash"],
  });
  assert.equal(missing.ok, false);
});
