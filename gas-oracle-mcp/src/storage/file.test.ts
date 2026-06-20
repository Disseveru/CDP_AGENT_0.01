import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileStorage } from "./file.js";

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
