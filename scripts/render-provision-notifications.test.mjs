import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveProvisionRedisUrl } from "./render-api.mjs";
import { computeRenderNotificationUpdates } from "./render-provision-notifications.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("resolveProvisionRedisUrl keeps Render REDIS_URL over RENDER_REDIS_URL", () => {
  const decision = resolveProvisionRedisUrl({
    renderVars: { REDIS_URL: "rediss://prod.example:6379" },
    renderRedisUrl: "rediss://dev.example:6379",
  });
  assert.equal(decision.action, "keep");
  assert.equal(decision.url, "rediss://prod.example:6379");
});

test("resolveProvisionRedisUrl skips when Render key exists but value is masked", () => {
  const decision = resolveProvisionRedisUrl({
    renderVars: { REDIS_URL: "" },
    renderRedisUrl: "rediss://dev.example:6379",
  });
  assert.equal(decision.action, "skip");
});

test("resolveProvisionRedisUrl sets from RENDER_REDIS_URL only when Render has no REDIS_URL key", () => {
  const decision = resolveProvisionRedisUrl({
    renderVars: {},
    renderRedisUrl: "rediss://new.example:6379",
  });
  assert.equal(decision.action, "set");
  assert.equal(decision.url, "rediss://new.example:6379");
});

test("resolveProvisionRedisUrl provisions when Redis is missing everywhere", () => {
  const decision = resolveProvisionRedisUrl({
    renderVars: { SMTP_HOST: "smtp.gmail.com" },
    renderRedisUrl: "",
  });
  assert.equal(decision.action, "provision");
});

test("resolveProvisionRedisUrl ignores generic REDIS_URL when Render has no key", () => {
  const decision = resolveProvisionRedisUrl({
    renderVars: {},
    renderRedisUrl: undefined,
  });
  assert.equal(decision.action, "provision");
});

test("computeRenderNotificationUpdates does not touch masked secrets", () => {
  const { updates } = computeRenderNotificationUpdates(
    {
      DATABASE_URL: "",
      MCP_API_KEY: "",
      SMTP_PASS: "",
      REDIS_URL: "",
      PUBLIC_URL: "https://cdp-agent-0-01.onrender.com",
      OPERATOR_EMAIL: "er2k18@gmail.com",
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "587",
      SMTP_USER: "er2k18@gmail.com",
      PRICE_CAPTCHA_SUBMIT: "$0.050",
      PRICE_CAPTCHA_BYPASS: "$0.075",
      CAPTCHA_TASK_TTL_SEC: "3600",
      CAPTCHA_POLL_TIMEOUT_MS: "300000",
      CAPTCHA_POLL_INTERVAL_MS: "2000",
    },
    {
      operatorEmail: "er2k18@gmail.com",
      serviceUrl: "https://cdp-agent-0-01.onrender.com",
    },
  );

  assert.ok(!updates.some((entry) => entry.key === "DATABASE_URL"));
  assert.ok(!updates.some((entry) => entry.key === "MCP_API_KEY"));
  assert.ok(!updates.some((entry) => entry.key === "SMTP_PASS"));
  assert.ok(!updates.some((entry) => entry.key === "REDIS_URL"));
});

test("computeRenderNotificationUpdates deletes Twilio keys when present on Render", () => {
  const { deletions } = computeRenderNotificationUpdates(
    {
      TWILIO_ACCOUNT_SID: "",
      OPERATOR_SMS_NUMBER: "",
      PUBLIC_URL: "https://cdp-agent-0-01.onrender.com",
      OPERATOR_EMAIL: "er2k18@gmail.com",
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "587",
      SMTP_USER: "er2k18@gmail.com",
      PRICE_CAPTCHA_SUBMIT: "$0.050",
      PRICE_CAPTCHA_BYPASS: "$0.075",
      CAPTCHA_TASK_TTL_SEC: "3600",
      CAPTCHA_POLL_TIMEOUT_MS: "300000",
      CAPTCHA_POLL_INTERVAL_MS: "2000",
      REDIS_URL: "rediss://prod.example:6379",
    },
    {
      operatorEmail: "er2k18@gmail.com",
      serviceUrl: "https://cdp-agent-0-01.onrender.com",
    },
  );

  assert.deepEqual(deletions, ["TWILIO_ACCOUNT_SID", "OPERATOR_SMS_NUMBER"]);
});

test("render-provision-notifications uses per-key setEnvVar, not bulk putEnvVars", () => {
  const source = readFileSync(join(repoRoot, "scripts", "render-provision-notifications.mjs"), "utf8");
  assert.match(source, /setEnvVar/);
  assert.doesNotMatch(source, /putEnvVars/);
});
