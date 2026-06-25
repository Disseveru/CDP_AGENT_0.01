import assert from "node:assert/strict";
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

test("sanitizeRequestHeaders strips hop-by-hop headers", () => {
  const headers = sanitizeRequestHeaders({
    Host: "evil.example",
    Connection: "close",
    Accept: "text/html",
  });
  assert.deepEqual(headers, { Accept: "text/html" });
});
