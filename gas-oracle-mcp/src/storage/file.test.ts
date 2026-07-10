import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileStorage } from "./file.js";

test("createInbox works with relative dataDir paths", async () => {
  const parent = mkdtempSync(join(tmpdir(), "agentwire-rel-"));
  const relativeDir = "./inboxes";
  const previous = process.cwd();
  process.chdir(parent);
  const storage = new FileStorage(relativeDir);
  try {
    await storage.init();
    const { inboxId, secret } = await storage.createInbox();
    assert.match(inboxId, /^[a-f0-9]{24}$/);
    await storage.appendEvent(inboxId, {
      method: "POST",
      headers: {},
      query: {},
      body: { ok: true },
    });
    const peeked = await storage.peekInbox(inboxId, secret);
    assert.equal(peeked.pending, 1);
  } finally {
    process.chdir(previous);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("concurrent appendEvent calls do not lose webhook events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentwire-file-"));
  const storage = new FileStorage(dir);

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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
