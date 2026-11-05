import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { test } from "node:test";

import { assertSafePublicUrl, sanitizeRequestHeaders } from "./http-safety.js";

test("assertSafePublicUrl rejects private IPv4 literals", async () => {
  await assert.rejects(() => assertSafePublicUrl("http://127.0.0.1/"), /Blocked private IP/);
  await assert.rejects(() => assertSafePublicUrl("http://10.0.0.1/"), /Blocked private IP/);
  await assert.rejects(() => assertSafePublicUrl("http://192.168.1.1/"), /Blocked private IP/);
});

test("assertSafePublicUrl rejects metadata hostnames", async () => {
  await assert.rejects(
    () => assertSafePublicUrl("http://metadata.google.internal/"),
    /Blocked hostname/,
  );
});

test("assertSafePublicUrl rejects decimal-encoded private IPs", async () => {
  await assert.rejects(() => assertSafePublicUrl("http://2130706433/"), /Blocked private IP/);
});

test("assertSafePublicUrl rejects embedded credentials", async () => {
  await assert.rejects(
    () => assertSafePublicUrl("http://user:pass@example.com/"),
    /embedded credentials/,
  );
});

test("assertSafePublicUrl rejects non-http schemes", async () => {
  await assert.rejects(() => assertSafePublicUrl("file:///etc/passwd"), /Only http/);
});

test("assertSafePublicUrl rejects an aborted validation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("deadline exceeded"));
  await assert.rejects(
    () => assertSafePublicUrl("https://example.com/", controller.signal),
    /deadline exceeded/,
  );
});

test("assertSafePublicUrl stops waiting for DNS when aborted", async (t) => {
  const lookup = t.mock.method(dns, "lookup", () => new Promise<never>(() => {}));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("deadline exceeded")), 10);
  try {
    await assert.rejects(
      () => assertSafePublicUrl("https://example.com/", controller.signal),
      /deadline exceeded/,
    );
  } finally {
    clearTimeout(timer);
  }
  assert.equal(lookup.mock.callCount(), 1);
});

test("sanitizeRequestHeaders strips hop-by-hop headers", () => {
  const headers = sanitizeRequestHeaders({
    Host: "evil.example",
    Connection: "close",
    Accept: "text/html",
  });
  assert.deepEqual(headers, { Accept: "text/html" });
});
