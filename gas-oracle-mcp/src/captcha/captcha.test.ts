import assert from "node:assert/strict";
import test from "node:test";

import { renderOperatorAlertEmail } from "./email-template.js";
import { renderOperatorSmsConsentPage } from "./operator-sms-consent-page.js";
import { buildEmailHtml, buildEmailSubject, buildSmsBody } from "./notifications.js";
import {
  NotificationConfigError,
  parseNotificationSettings,
  parseOperatorAlertPageUrl,
  parseOperatorAlertSolveUrl,
  TWILIO_API_BASE_URL,
} from "./notification-config.js";
import { renderSolvePage } from "./solve-page.js";
import { isCaptchaStorageConfigured } from "./store.js";
import { captchaWidgetScript, submitBodySchema } from "./tasks.js";
import { buildCaptchaSubmitRouteConfig } from "../payments.js";
import type { CaptchaTask } from "./types.js";

function extractFirstMatch(html: string, pattern: RegExp): string | null {
  const match = pattern.exec(html);
  return match?.[1] ?? null;
}

function extractScriptConstant(html: string, name: string): string | null {
  return extractFirstMatch(html, new RegExp(`const ${name} = "([^"]*)";`));
}

function extractScriptSrc(html: string): string | null {
  return extractFirstMatch(html, /<script src="([^"]+)"/);
}

function extractDataSitekey(html: string): string | null {
  return extractFirstMatch(html, /data-sitekey="([^"]*)"/);
}

function extractFetchSolvePath(html: string): string | null {
  if (!/fetch\("\/api\/v1\/captcha\/solve\/" \+ TASK_ID/.test(html)) {
    return null;
  }
  const taskId = extractScriptConstant(html, "TASK_ID");
  return taskId === null ? null : `/api/v1/captcha/solve/${taskId}`;
}

function extractMetaTaskLine(html: string): string | null {
  return extractFirstMatch(html, /<p class="meta">Task ([^<]*)<\/p>/);
}

const baseTask = (): CaptchaTask => ({
  task_id: "550e8400-e29b-41d4-a716-446655440000",
  sitekey: "site-key",
  pageurl: "https://example.com/login",
  captcha_type: "hcaptcha",
  status: "pending",
  created_at: new Date().toISOString(),
});

const baseAlert = {
  taskId: "550e8400-e29b-41d4-a716-446655440000",
  solveUrl: "https://gas-oracle-mcp-production.up.railway.app/solve/550e8400-e29b-41d4-a716-446655440000",
  captchaType: "recaptcha" as const,
  pageUrl: "https://example.com/login",
};

test("submitBodySchema validates captcha submit payload", () => {
  const parsed = submitBodySchema.parse({
    sitekey: "abc",
    pageurl: "https://example.com",
    captcha_type: "turnstile",
  });
  assert.equal(parsed.captcha_type, "turnstile");
});

test("parseNotificationSettings allows fully disabled channels", () => {
  const settings = parseNotificationSettings({
    OPERATOR_SMS_NUMBER: "+17472241814",
  });
  assert.equal(settings.sms, null);
  assert.equal(settings.email, null);
  assert.equal(settings.operatorSmsNumber, "+17472241814");
});

test("parseNotificationSettings rejects partial Twilio configuration", () => {
  assert.throws(
    () =>
      parseNotificationSettings({
        TWILIO_ACCOUNT_SID: "ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    (error: unknown) => {
      assert.ok(error instanceof NotificationConfigError);
      assert.match(error.message, /incomplete/i);
      return true;
    },
  );
});

test("parseNotificationSettings validates complete Twilio configuration", () => {
  const settings = parseNotificationSettings({
    TWILIO_ACCOUNT_SID: "ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    TWILIO_AUTH_TOKEN: "0123456789abcdef",
    TWILIO_FROM_NUMBER: "+15551234567",
  });
  assert.ok(settings.sms);
  assert.equal(settings.sms.apiBaseUrl, TWILIO_API_BASE_URL);
  assert.equal(settings.sms.fromNumber, "+15551234567");
});

test("parseNotificationSettings normalizes Twilio from numbers missing a leading plus", () => {
  const settings = parseNotificationSettings({
    TWILIO_ACCOUNT_SID: "ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    TWILIO_AUTH_TOKEN: "0123456789abcdef",
    TWILIO_FROM_NUMBER: "18445551234",
  });
  assert.ok(settings.sms);
  assert.equal(settings.sms.fromNumber, "+18445551234");
});

test("parseNotificationSettings rejects partial SMTP configuration", () => {
  assert.throws(
    () =>
      parseNotificationSettings({
        SMTP_USER: "ops@example.com",
      }),
    (error: unknown) => {
      assert.ok(error instanceof NotificationConfigError);
      assert.match(error.message, /incomplete/i);
      return true;
    },
  );
});

test("parseNotificationSettings validates complete SMTP configuration", () => {
  const settings = parseNotificationSettings({
    SMTP_USER: "ops@example.com",
    SMTP_PASS: "app-password",
    SMTP_HOST: "smtp.gmail.com",
    SMTP_PORT: "587",
  });
  assert.ok(settings.email);
  assert.equal(settings.email.host, "smtp.gmail.com");
  assert.equal(settings.email.port, 587);
});

test("parseOperatorAlertSolveUrl rejects non-https solve links", () => {
  assert.throws(
    () => parseOperatorAlertSolveUrl("http://example.com/solve"),
    (error: unknown) => {
      assert.ok(error instanceof NotificationConfigError);
      return true;
    },
  );
});

test("parseOperatorAlertPageUrl accepts http target pages", () => {
  assert.equal(parseOperatorAlertPageUrl("http://example.com/login"), "http://example.com/login");
});

test("buildSmsBody succeeds when target page uses http", () => {
  const body = buildSmsBody({
    ...baseAlert,
    pageUrl: "http://example.com/login",
  });
  assert.match(body, /Solve here: https:\/\//);
  assert.doesNotMatch(body, /http:\/\/example\.com\/login/);
});

test("buildEmailHtml renders http page URLs as text without clickable links", () => {
  const html = buildEmailHtml({
    taskId: "task-123",
    solveUrl: "https://example.com/solve/task-123",
    captchaType: "recaptcha",
    pageUrl: "http://example.com/login",
  });

  assert.match(html, /http:\/\/example\.com\/login/);
  assert.doesNotMatch(html, /href="http:\/\/example\.com\/login"/);
});

test("buildSmsBody includes sanitized task id and solve URL", () => {
  const body = buildSmsBody(baseAlert);
  assert.equal(
    body,
    "⚠️ CAPTCHA Alert: Agent task 550e8400-e29b-41d4-a716-446655440000 is waiting. Solve here: https://gas-oracle-mcp-production.up.railway.app/solve/550e8400-e29b-41d4-a716-446655440000",
  );
});

test("buildEmailSubject truncates long task ids safely", () => {
  const subject = buildEmailSubject({
    ...baseAlert,
    taskId: "abcdefgh-ijkl-mnop",
  });
  assert.equal(subject, "⚠️ CAPTCHA Alert: task abcdefgh…");
});

test("buildEmailHtml escapes injected markup in alert fields", () => {
  const html = buildEmailHtml({
    taskId: "task-123",
    solveUrl: "https://example.com/solve/task-123",
    captchaType: "recaptcha",
    pageUrl: "https://example.com/<script>alert(1)</script>",
  });

  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<strong>Task:<\/strong> task-123/);
  assert.match(html, /Solve now/);
});

test("renderOperatorAlertEmail uses https links only", () => {
  const html = renderOperatorAlertEmail({
    taskId: "task-123",
    solveUrl: "https://example.com/solve/task-123",
    captchaType: "turnstile",
    pageUrl: "https://example.com/page",
  });

  const solveHref = extractFirstMatch(html, /href="(https:\/\/example\.com\/solve\/task-123)"/);
  assert.equal(solveHref, "https://example.com/solve/task-123");
});

test("renderOperatorSmsConsentPage documents operator opt-in for Twilio verification", () => {
  const html = renderOperatorSmsConsentPage({
    serviceName: "AgentWire",
    publicUrl: "https://gas-oracle-mcp-production.up.railway.app",
    operatorSmsNumber: "+17472241814",
    operatorEmail: "er2k18@gmail.com",
  });

  assert.match(html, /<title>AgentWire — Operator SMS consent<\/title>/);
  assert.match(html, /OPERATOR_SMS_NUMBER/);
  assert.match(html, /\+17472241814/);
  assert.match(html, /Reply <strong>STOP<\/strong> to unsubscribe/);
  assert.match(html, /CAPTCHA Alert: Agent task/);
  assert.doesNotMatch(html, /<script>/);
});

test("renderSolvePage injects task id and solve endpoint safely", () => {
  const task = baseTask();
  const html = renderSolvePage(task);

  const taskIdConstant = extractScriptConstant(html, "TASK_ID");
  assert.equal(taskIdConstant, task.task_id);

  const fetchPath = extractFetchSolvePath(html);
  assert.equal(fetchPath, `/api/v1/captcha/solve/${task.task_id}`);

  const metaTask = extractMetaTaskLine(html);
  assert.equal(metaTask, task.task_id);

  const scriptSrc = extractScriptSrc(html);
  assert.equal(scriptSrc, captchaWidgetScript("hcaptcha").scriptUrl);

  assert.match(html, /id="submit-btn"/);
  assert.match(html, /solution_token/);
});

test("renderSolvePage escapes malicious sitekey and task id values", () => {
  const task: CaptchaTask = {
    ...baseTask(),
    captcha_type: "turnstile",
    task_id: '"><script>alert("xss")</script>',
    sitekey: '" onerror="alert(1)',
  };

  const html = renderSolvePage(task);

  assert.doesNotMatch(html, /<script>alert\("xss"\)<\/script>/);
  assert.doesNotMatch(html, /onerror="alert\(1\)"/);

  const sitekey = extractDataSitekey(html);
  assert.equal(sitekey, '&quot; onerror=&quot;alert(1)');

  const taskIdConstant = extractScriptConstant(html, "TASK_ID");
  assert.equal(taskIdConstant, '&quot;&gt;&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');

  const fetchPath = extractFetchSolvePath(html);
  assert.equal(
    fetchPath,
    '/api/v1/captcha/solve/&quot;&gt;&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
  );
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
