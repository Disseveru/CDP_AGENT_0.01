import assert from "node:assert/strict";
import test from "node:test";

import { resolveProvisionRedisUrl } from "./render-api.mjs";

test("resolveProvisionRedisUrl keeps Render REDIS_URL over local env", () => {
  const decision = resolveProvisionRedisUrl({
    renderVars: { REDIS_URL: "rediss://prod.example:6379" },
    envRedisUrl: "rediss://dev.example:6379",
  });
  assert.equal(decision.action, "keep");
  assert.equal(decision.url, "rediss://prod.example:6379");
});

test("resolveProvisionRedisUrl skips when Render key exists but value is masked", () => {
  const decision = resolveProvisionRedisUrl({
    renderVars: { REDIS_URL: "" },
    envRedisUrl: "rediss://dev.example:6379",
  });
  assert.equal(decision.action, "skip");
});

test("resolveProvisionRedisUrl sets from env only when Render has no REDIS_URL key", () => {
  const decision = resolveProvisionRedisUrl({
    renderVars: {},
    envRedisUrl: "rediss://new.example:6379",
  });
  assert.equal(decision.action, "set");
  assert.equal(decision.url, "rediss://new.example:6379");
});

test("resolveProvisionRedisUrl provisions when Redis is missing everywhere", () => {
  const decision = resolveProvisionRedisUrl({
    renderVars: { SMTP_HOST: "smtp.gmail.com" },
    envRedisUrl: "",
  });
  assert.equal(decision.action, "provision");
});
