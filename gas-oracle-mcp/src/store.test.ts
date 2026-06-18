import assert from "node:assert/strict";
import test from "node:test";

import {
  appendEvent,
  createInbox,
  drainInbox,
  peekInbox,
  removeInboxEventsByIds,
} from "./store.js";

test("removeInboxEventsByIds deletes only the acknowledged event ids", () => {
  const { inboxId, secret } = createInbox();

  appendEvent(inboxId, {
    method: "POST",
    headers: {},
    query: {},
    body: "first",
  });
  appendEvent(inboxId, {
    method: "POST",
    headers: {},
    query: {},
    body: "second",
  });

  const peeked = peekInbox(inboxId, secret);
  assert.equal(peeked.pending, 2);

  const firstId = peeked.events[0].id;
  const removed = removeInboxEventsByIds(inboxId, secret, [firstId]);
  assert.equal(removed.removed, 1);

  const remaining = peekInbox(inboxId, secret);
  assert.equal(remaining.pending, 1);
  assert.equal(remaining.events[0].body, "second");

  drainInbox(inboxId, secret);
});

test("peek before settlement preserves events when acknowledgement is skipped", () => {
  const { inboxId, secret } = createInbox();

  appendEvent(inboxId, {
    method: "POST",
    headers: {},
    query: {},
    body: { type: "payment" },
  });

  const peeked = peekInbox(inboxId, secret);
  assert.equal(peeked.pending, 1);

  const retry = peekInbox(inboxId, secret);
  assert.deepEqual(retry.events, peeked.events);

  drainInbox(inboxId, secret);
});
