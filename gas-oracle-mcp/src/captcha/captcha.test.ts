import assert from "node:assert/strict";
import test from "node:test";

import { buildSmsBody } from "./notifications.js";
import { renderSolvePage } from "./solve-page.js";
import { isCaptchaStorageConfigured } from "./store.js";
import { captchaWidgetScript, submitBodySchema } from "./tasks.js";
import { buildCaptchaSubmitRouteConfig } from "../payments.js";
import type { CaptchaTask } from "./types.js";

test("submitBodySchema validates captcha submit payload", () => {
  const parsed = submitBodySchema.parse({
    sitekey: "abc",
    pageurl: "https://example.com",
    captcha_type: "turnstile",
  });
  assert.equal(parsed.captcha_type, "turnstile");
});

test("buildSmsBody matches operator alert format", () => {
  const body = buildSmsBody({
    taskId: "task-123",
    solveUrl: "https://gas-oracle-mcp-production.up.railway.app/solve/task-123",
    captchaType: "recaptcha",
    pageUrl: "https://example.com",
  });
  assert.match(body, /⚠️ CAPTCHA Alert: Agent task task-123 is waiting/);
  assert.match(body, /solve\/task-123/);
});

test("renderSolvePage includes widget script and task id", () => {
  const task: CaptchaTask = {
    task_id: "550e8400-e29b-41d4-a716-446655440000",
    sitekey: "site-key",
    pageurl: "https://example.com/login",
    captcha_type: "hcaptcha",
    status: "pending",
    created_at: new Date().toISOString(),
  };
  const html = renderSolvePage(task);
  assert.match(html, /hcaptcha\.com/);
  assert.match(html, /550e8400-e29b-41d4-a716-446655440000/);
  assert.match(html, /Submit Solution/);
});

test("captchaWidgetScript maps all providers", () => {
  assert.equal(captchaWidgetScript("recaptcha").globalName, "grecaptcha");
  assert.equal(captchaWidgetScript("hcaptcha").globalName, "hcaptcha");
  assert.equal(captchaWidgetScript("turnstile").globalName, "turnstile");
});

test("buildCaptchaSubmitRouteConfig passes Bazaar route validation", () => {
  const config = buildCaptchaSubmitRouteConfig("0x0000000000000000000000000000000000000001");
  assert.equal(config.resource?.includes("/api/v1/captcha/submit"), true);
  assert.ok(config.extensions?.bazaar);
});

test("isCaptchaStorageConfigured reflects REDIS_URL", () => {
  const previous = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  assert.equal(isCaptchaStorageConfigured(), false);
  if (previous) process.env.REDIS_URL = previous;
});
