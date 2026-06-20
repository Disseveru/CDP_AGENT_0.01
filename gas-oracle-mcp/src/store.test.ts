import assert from "node:assert/strict";
import test from "node:test";

import {
  appendEvent,
  createInbox,
  drainInbox,
  peekInbox,
  removeInboxEventsByIds,
} from "./store.js";

test("removeInboxEventsByIds deletes only the acknowledged event ids", async () => {
  const { inboxId, secret } = await createInbox();

  await appendEvent(inboxId, {
    method: "POST",
    headers: {},
    query: {},
    body: "first",
  });
  await appendEvent(inboxId, {
    method: "POST",
    headers: {},
    query: {},
    body: "second",
  });

  const peeked = await peekInbox(inboxId, secret);
  assert.equal(peeked.pending, 2);

  const firstId = peeked.events[0].id;
  const removed = await removeInboxEventsByIds(inboxId, secret, [firstId]);
  assert.equal(removed.removed, 1);

  const remaining = await peekInbox(inboxId, secret);
  assert.equal(remaining.pending, 1);
  assert.equal(remaining.events[0].body, "second");

  await drainInbox(inboxId, secret);
});

test("peek before settlement preserves events when acknowledgement is skipped", async () => {
  const { inboxId, secret } = await createInbox();

  await appendEvent(inboxId, {
    method: "POST",
    headers: {},
    query: {},
    body: { type: "payment" },
  });

  const peeked = await peekInbox(inboxId, secret);
  assert.equal(peeked.pending, 1);

  const retry = await peekInbox(inboxId, secret);
  assert.deepEqual(retry.events, peeked.events);

  await drainInbox(inboxId, secret);
});

test("invalid inbox ids are rejected before touching disk", async () => {
  await assert.rejects(() => peekInbox("../etc/passwd", "secret"), /Invalid inbox ID/);
});
