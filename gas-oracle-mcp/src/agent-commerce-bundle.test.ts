import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateAgentBudget,
  issueDeliveryReceipt,
  screenPayAsset,
} from "./agent-commerce-bundle.js";

test("screenPayAsset allows Base USDC exact quotes", () => {
  const result = screenPayAsset({
    asset: "USDC",
    network: "eip155:8453",
    payTo: "0x0000000000000000000000000000000000000001",
    amountUsd: "0.01",
    maxAmountUsd: "1",
  });
  assert.equal(result.verdict, "allow");
  assert.equal(result.normalized.knownUsdc, true);
});

test("screenPayAsset denies non-stable assets", () => {
  const result = screenPayAsset({
    asset: "PEPE",
    network: "eip155:8453",
    payTo: "0x0000000000000000000000000000000000000001",
    amountUsd: "0.01",
  });
  assert.equal(result.verdict, "deny");
});

test("screenPayAsset reviews missing payTo", () => {
  const result = screenPayAsset({ asset: "USDC", network: "eip155:8453" });
  assert.equal(result.verdict, "review");
});

test("allocateAgentBudget splits even shares and respects caps", () => {
  const result = allocateAgentBudget({
    totalUsd: "10",
    reserveUsd: "1",
    lines: [{ agentId: "a" }, { agentId: "b", maxUsd: "2" }],
  });
  assert.equal(result.allocatableUsd, 9);
  assert.equal(result.lines[0].grantedUsd, 4.5);
  assert.equal(result.lines[1].grantedUsd, 2);
  assert.equal(result.lines[1].capped, true);
});

test("allocateAgentBudget rejects empty fleet", () => {
  assert.throws(() => allocateAgentBudget({ totalUsd: 1, lines: [] }), /non-empty/);
});

test("issueDeliveryReceipt is deterministic for the same payload", () => {
  const a = issueDeliveryReceipt({
    seller: "agentwire",
    buyer: "0xabc",
    resource: "/quote_gas",
    payload: { chain: "base", extra: 1 },
    amountUsd: "0.002",
    txHash: "0x1",
  });
  const b = issueDeliveryReceipt({
    seller: "agentwire",
    buyer: "0xabc",
    resource: "/quote_gas",
    payload: { extra: 1, chain: "base" },
    amountUsd: "0.002",
    txHash: "0x1",
  });
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.receiptId, b.receiptId);
  assert.match(a.receiptId, /^rcpt_[0-9a-f]{16}$/);
});
