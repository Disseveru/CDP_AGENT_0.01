import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateHealthEndpoint,
  evaluateReadyEndpoint,
  evaluateRenderEnv,
  evaluateSseWithAuth,
  evaluateSseWithoutAuth,
  formatMarkdownReport,
  summarizeReport,
} from "./repo-health-report.mjs";

test("evaluateHealthEndpoint passes healthy runtime", () => {
  const check = evaluateHealthEndpoint(200, {
    status: "ok",
    runtimeStatus: "ready",
    storage: { backend: "postgres", ok: true },
    redis: { ok: true },
  });
  assert.equal(check.ok, true);
});

test("evaluateHealthEndpoint fails when runtime is not ready", () => {
  const check = evaluateHealthEndpoint(200, { status: "ok", runtimeStatus: "starting" });
  assert.equal(check.ok, false);
});

test("evaluateReadyEndpoint requires payments", () => {
  assert.equal(evaluateReadyEndpoint(200, { status: "ready", paymentsAvailable: true }).ok, true);
  assert.equal(evaluateReadyEndpoint(200, { status: "ready", paymentsAvailable: false }).ok, false);
});

test("evaluateSseWithoutAuth rejects open MCP", () => {
  assert.equal(evaluateSseWithoutAuth(401).ok, true);
  assert.equal(evaluateSseWithoutAuth(200).ok, false);
});

test("evaluateSseWithAuth accepts 200", () => {
  assert.equal(evaluateSseWithAuth(200).ok, true);
  assert.equal(evaluateSseWithAuth(401).ok, false);
});

test("evaluateRenderEnv flags missing secrets", () => {
  const checks = evaluateRenderEnv({ PUBLIC_URL: "https://example.com" });
  assert.ok(checks.some((c) => c.name === "render_env_mcp_api_key" && !c.ok));
  assert.ok(checks.some((c) => c.name === "render_env_database_url" && !c.ok));
});

test("summarizeReport fails on critical checks only by default", () => {
  const report = summarizeReport([
    { name: "health", level: "critical", ok: true, detail: "ok" },
    { name: "render_env_redis_url", level: "warning", ok: false, detail: "missing" },
  ]);
  assert.equal(report.ok, true);
  assert.equal(
    summarizeReport(
      [{ name: "health", level: "critical", ok: false, detail: "down" }],
      { failOnWarn: false },
    ).ok,
    false,
  );
});

test("formatMarkdownReport includes overall status", () => {
  const md = formatMarkdownReport(
    summarizeReport([{ name: "health", level: "critical", ok: true, detail: "ok" }]),
    "https://cdp-agent-0-01.onrender.com",
  );
  assert.match(md, /PASS/);
  assert.match(md, /cdp-agent-0-01\.onrender\.com/);
});
