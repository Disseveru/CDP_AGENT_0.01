import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSellerDossier,
  consumePaySession,
  issuePaySession,
  receiptSlaPack,
  validateSellerPayload,
  verifyPaySession,
} from "./ops-sku.js";

test("pay session issues, verifies, and debits within budget", () => {
  process.env.PAY_SESSION_HMAC_SECRET = "unit-test-session";
  process.env.RECEIPT_HMAC_SECRET = "unit-test-receipt";
  const session = issuePaySession({
    parentAgent: "parent-1",
    childAgent: "child-1",
    budgetUsd: "0.050",
    allowlistSkus: ["quote_gas", "verify_settlement"],
    ttlSeconds: 600,
  });
  assert.equal(verifyPaySession(session).valid, true);
  const blocked = consumePaySession({ session, sku: "fetch_url", amountUsd: "0.01" });
  assert.equal(blocked.allowed, false);
  const ok = consumePaySession({ session, sku: "quote_gas", amountUsd: "0.002" });
  assert.equal(ok.allowed, true);
  assert.equal(ok.session?.spentUsd, "0.002000");
  const over = consumePaySession({ session: ok.session!, sku: "quote_gas", amountUsd: "1.00" });
  assert.equal(over.allowed, false);
});

test("validateSellerPayload redacts secrets and hashes content", () => {
  const result = validateSellerPayload({
    payload: { accepts: [{ scheme: "exact" }], authorization: "Bearer secret", note: "ok" },
    requiredKeys: ["accepts"],
  });
  assert.equal(result.ok, true);
  assert.equal((result.redacted as { authorization: string }).authorization, "[redacted]");
  assert.equal(result.contentHash.length, 64);
});

test("seller dossier flags thin liquidity and scores hygiene", () => {
  const dossier = buildSellerDossier({
    host: "api.example.com",
    uniquePayers30d: 1,
    medianTicketUsd: "0.01",
    payload: {
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          payTo: "0x0000000000000000000000000000000000000001",
        },
      ],
    },
  });
  assert.ok(dossier.score >= 60);
  assert.ok(dossier.flags.some((f) => f.includes("unique payers")));
});

test("receipt sla pack returns signed receipt and hold quote", () => {
  process.env.RECEIPT_HMAC_SECRET = "unit-test-receipt";
  const pack = receiptSlaPack({
    sku: "quote_gas",
    buyer: "0xbuyer",
    seller: "0xseller",
    amountUsd: "0.002",
    payload: { result: "ok" },
    slaHours: 1,
    penaltyBps: 500,
  });
  assert.equal(pack.receipt.sku, "quote_gas");
  assert.equal(pack.sla.holdUsd, 0.0025);
  assert.match(pack.recommendation, /Attach receipt/);
});
