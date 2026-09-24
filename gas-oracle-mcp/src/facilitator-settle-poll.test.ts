import assert from "node:assert/strict";
import test from "node:test";

import { extractSettleState, pollFacilitatorSettle } from "./facilitator-settle-poll.js";

test("extractSettleState reads tx hash and success flags", () => {
  const hash = "0x" + "ab".repeat(32);
  const settled = extractSettleState({ success: true, txHash: hash }, 200);
  assert.equal(settled.settled, true);
  assert.equal(settled.txHash, hash);

  const pending = extractSettleState({ status: "pending" }, 200);
  assert.equal(pending.pending, true);
  assert.equal(pending.settled, false);

  const serverErr = extractSettleState({ success: true }, 503);
  assert.equal(serverErr.pending, true);
});

test("pollFacilitatorSettle rejects non-https", async () => {
  await assert.rejects(() => pollFacilitatorSettle({ facilitatorUrl: "http://example.com" }), /https/);
});

test("pollFacilitatorSettle uses injected fetch", async () => {
  const hash = "0x" + "cd".repeat(32);
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ settled: true, transactionHash: hash }), { status: 200 })) as typeof fetch;
  const result = await pollFacilitatorSettle(
    { facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402/settle" },
    fakeFetch,
  );
  assert.equal(result.ok, true);
  assert.equal(result.settled, true);
  assert.equal(result.txHash, hash);
});
