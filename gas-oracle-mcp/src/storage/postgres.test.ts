import assert from "node:assert/strict";
import test from "node:test";

import { closePool } from "../db.js";
import { runMigrations } from "../migrate.js";
import { PostgresStorage } from "./postgres.js";

const databaseUrl = process.env.DATABASE_URL?.trim();

test("concurrent appendEvent calls do not lose webhook events", { skip: !databaseUrl }, async () => {
  await runMigrations();
  const { getPool } = await import("../db.js");
  const storage = new PostgresStorage(getPool());

  try {
    await storage.init();
    const { inboxId, secret } = await storage.createInbox();

    const bodies = ["a", "b", "c", "d", "e"];
    await Promise.all(
      bodies.map((body) =>
        storage.appendEvent(inboxId, {
          method: "POST",
          headers: {},
          query: {},
          body,
        }),
      ),
    );

    const peeked = await storage.peekInbox(inboxId, secret);
    assert.equal(peeked.pending, bodies.length);
    assert.deepEqual(
      peeked.events.map((event) => event.body).sort(),
      bodies.sort(),
    );

    await storage.drainInbox(inboxId, secret);
  } finally {
    await closePool();
  }
});
