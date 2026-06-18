import assert from "node:assert/strict";
import test from "node:test";

import { extractLinks } from "./links.js";
import { getInboxStats } from "./inbox.js";
import { relayPost } from "./relay.js";
import { appendEvent, createInbox, drainInbox } from "./store.js";

test("getInboxStats returns counts without exposing event bodies", () => {
  const { inboxId, secret } = createInbox();

  appendEvent(inboxId, {
    method: "POST",
    headers: {},
    query: {},
    body: { secret: "payload" },
  });

  const stats = getInboxStats({ inboxId, secret });
  assert.equal(stats.pending, 1);
  assert.ok(stats.oldestEventAt);
  assert.ok(stats.newestEventAt);
  assert.equal("events" in stats, false);

  drainInbox(inboxId, secret);
});

test("extractLinks parses anchor tags from HTML", async () => {
  const html = `<!doctype html><html><head><title>Test</title></head><body>
    <a href="/local">Local</a>
    <a href="https://example.org/external">External</a>
  </body></html>`;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  try {
    const result = await extractLinks({ url: "https://example.com/page", sameOrigin: true, limit: 10 });
    assert.equal(result.title, "Test");
    assert.equal(result.links.length, 1);
    assert.equal(result.links[0].href, "https://example.com/local");
    assert.equal(result.links[0].text, "Local");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayPost rejects unsupported methods", async () => {
  await assert.rejects(
    () => relayPost({ url: "https://example.com", method: "DELETE" as "POST" }),
    /not allowed/,
  );
});

test("relayPost serializes JSON bodies", async () => {
  let seenBody = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    seenBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await relayPost({
      url: "https://example.com/hook",
      body: { agent: "wire" },
    });
    assert.equal(JSON.parse(seenBody).agent, "wire");
    assert.equal((result.responseBody as { ok: boolean }).ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
