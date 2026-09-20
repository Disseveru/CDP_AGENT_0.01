import assert from "node:assert/strict";
import test from "node:test";

import { pollFacilitatorSettle } from "./settle-poll.js";

test("pollFacilitatorSettle stops when success:true", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ success: true, transaction: `0x${"ab".repeat(32)}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const result = await pollFacilitatorSettle({
    facilitatorUrl: "https://facilitator.example/settle",
    maxAttempts: 3,
    intervalMs: 0,
    fetchImpl: fakeFetch,
  });
  assert.equal(result.settled, true);
  assert.equal(calls, 1);
  assert.equal(result.attempts.length, 1);
  assert.match(result.recommendation, /confirmed/i);
});

test("pending hash is not treated as terminal failure", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ success: false, transaction: `0x${"cd".repeat(32)}` }), {
      status: 200,
    })) as typeof fetch;

  const result = await pollFacilitatorSettle({
    facilitatorUrl: "https://facilitator.example/settle",
    maxAttempts: 2,
    intervalMs: 0,
    fetchImpl: fakeFetch,
  });
  assert.equal(result.settled, false);
  assert.equal(result.pending, true);
  assert.equal(result.attempts.length, 2);
});

test("rejects http facilitator urls", async () => {
  await assert.rejects(
    () => pollFacilitatorSettle({ facilitatorUrl: "http://insecure.example/settle" }),
    /https/,
  );
});
