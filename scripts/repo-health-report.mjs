#!/usr/bin/env node
/**
 * Production health report for AgentWire on Render.
 * Used by GitHub Actions (.github/workflows/production-health.yml) and locally:
 *   npm run repo:health-report
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { findService, getEnvVars, getRenderApiKey, servicePublicUrl } from "./render-api.mjs";

const DEFAULT_RENDER_URL = "https://cdp-agent-0-01.onrender.com";

const { values: args } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    "fail-on-warn": { type: "boolean", default: false },
    url: { type: "string" },
  },
  allowPositionals: true,
});

/** @typedef {{ name: string, level: "critical" | "warning", ok: boolean, detail: string }} HealthCheck */

/**
 * @param {number} status
 * @param {Record<string, unknown>} body
 * @returns {HealthCheck}
 */
export function evaluateHealthEndpoint(status, body) {
  const runtime = String(body.runtimeStatus ?? "");
  const serviceStatus = String(body.status ?? "");
  const storageOk = body.storage == null || body.storage?.ok !== false;
  const redisOk = body.redis == null || body.redis?.ok !== false;
  const ok = status === 200 && serviceStatus === "ok" && runtime === "ready" && storageOk && redisOk;
  const parts = [`HTTP ${status}`, `status=${serviceStatus}`, `runtime=${runtime}`];
  if (body.storage) parts.push(`storage=${body.storage.backend} ok=${body.storage.ok}`);
  if (body.redis) parts.push(`redis ok=${body.redis.ok}`);
  return {
    name: "health",
    level: "critical",
    ok,
    detail: parts.join(", "),
  };
}

/**
 * @param {number} status
 * @param {Record<string, unknown>} body
 * @returns {HealthCheck}
 */
export function evaluateReadyEndpoint(status, body) {
  const readyStatus = String(body.status ?? "");
  const payments = body.paymentsAvailable;
  const ok = status === 200 && readyStatus === "ready" && payments !== false;
  return {
    name: "ready",
    level: "critical",
    ok,
    detail: `HTTP ${status}, status=${readyStatus}, payments=${payments ?? "?"}`,
  };
}

/** @param {number | null} status */
export function evaluateSseWithoutAuth(status) {
  if (status == null) {
    return {
      name: "mcp_auth_required",
      level: "critical",
      ok: false,
      detail: "SSE request failed",
    };
  }
  const ok = status === 401 || status === 403;
  return {
    name: "mcp_auth_required",
    level: "critical",
    ok,
    detail: ok
      ? `HTTP ${status} (auth required — good)`
      : `HTTP ${status} — MCP endpoint is open without auth`,
  };
}

/** @param {number | null} status */
export function evaluateSseWithAuth(status) {
  if (status == null) {
    return {
      name: "mcp_auth_accepted",
      level: "warning",
      ok: false,
      detail: "Authenticated SSE request failed",
    };
  }
  const ok = status === 200;
  return {
    name: "mcp_auth_accepted",
    level: "warning",
    ok,
    detail: `HTTP ${status}`,
  };
}

const REQUIRED_RENDER_KEYS = [
  "MCP_API_KEY",
  "DATABASE_URL",
  "CDP_API_KEY",
  "CDP_PRIVATE_KEY",
  "CDP_WALLET_SECRET",
  "PUBLIC_URL",
];

/**
 * @param {Record<string, string>} vars
 * @returns {HealthCheck[]}
 */
export function evaluateRenderEnv(vars) {
  const checks = [];
  for (const key of REQUIRED_RENDER_KEYS) {
    const present = Boolean(vars[key]?.trim());
    checks.push({
      name: `render_env_${key.toLowerCase()}`,
      level: "warning",
      ok: present,
      detail: present ? "set" : "missing on Render",
    });
  }
  if (vars.STORAGE_BACKEND && vars.STORAGE_BACKEND !== "postgres") {
    checks.push({
      name: "render_env_storage_backend",
      level: "warning",
      ok: false,
      detail: `STORAGE_BACKEND=${vars.STORAGE_BACKEND} (expected postgres)`,
    });
  }
  return checks;
}

/**
 * @param {HealthCheck[]} checks
 * @param {{ failOnWarn?: boolean }} options
 */
export function summarizeReport(checks, { failOnWarn = false } = {}) {
  const criticalFailed = checks.filter((c) => c.level === "critical" && !c.ok);
  const warningFailed = checks.filter((c) => c.level === "warning" && !c.ok);
  const ok = criticalFailed.length === 0 && (!failOnWarn || warningFailed.length === 0);
  return { ok, criticalFailed, warningFailed, checks };
}

/**
 * @param {string} url
 * @param {{ mcpApiKey?: string, renderApiKey?: string, failOnWarn?: boolean, fetchImpl?: typeof fetch }} options
 */
export async function runHealthReport(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const checks = [];

  let healthBody = {};
  try {
    const res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(120_000) });
    healthBody = await res.json().catch(() => ({}));
    checks.push(evaluateHealthEndpoint(res.status, healthBody));
  } catch (error) {
    checks.push({
      name: "health",
      level: "critical",
      ok: false,
      detail: `request failed: ${error.message || error}`,
    });
  }

  let readyBody = {};
  try {
    const res = await fetchImpl(`${url}/ready`, { signal: AbortSignal.timeout(120_000) });
    readyBody = await res.json().catch(() => ({}));
    checks.push(evaluateReadyEndpoint(res.status, readyBody));
  } catch (error) {
    checks.push({
      name: "ready",
      level: "critical",
      ok: false,
      detail: `request failed: ${error.message || error}`,
    });
  }

  let sseNoAuthStatus = null;
  try {
    const res = await fetchImpl(`${url}/sse`, { signal: AbortSignal.timeout(30_000) });
    sseNoAuthStatus = res.status;
    await res.body?.cancel?.();
  } catch {
    sseNoAuthStatus = null;
  }
  checks.push(evaluateSseWithoutAuth(sseNoAuthStatus));

  const mcpKey = options.mcpApiKey?.trim();
  if (mcpKey) {
    let sseAuthStatus = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const res = await fetchImpl(`${url}/sse`, {
        headers: { Authorization: `Bearer ${mcpKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      sseAuthStatus = res.status;
      await res.body?.cancel?.();
    } catch {
      sseAuthStatus = null;
    }
    checks.push(evaluateSseWithAuth(sseAuthStatus));
  }

  const renderApiKey = options.renderApiKey?.trim() || getRenderApiKey();
  if (renderApiKey) {
    try {
      let service = await findService({ url });
      if (!service) service = await findService({ name: "CDP_AGENT_0.01" });
      if (!service) service = await findService({ name: "agentwire" });
      if (service) {
        const vars = await getEnvVars(service.id);
        checks.push(...evaluateRenderEnv(vars));
        checks.push({
          name: "render_service",
          level: "warning",
          ok: true,
          detail: `${service.name} (${service.id}) @ ${servicePublicUrl(service) || url}`,
        });
      } else {
        checks.push({
          name: "render_service",
          level: "warning",
          ok: false,
          detail: `No Render service matched ${url}`,
        });
      }
    } catch (error) {
      checks.push({
        name: "render_service",
        level: "warning",
        ok: false,
        detail: `Render API error: ${error.message || error}`,
      });
    }
  }

  return summarizeReport(checks, { failOnWarn: options.failOnWarn });
}

/** @param {{ ok: boolean, criticalFailed: HealthCheck[], warningFailed: HealthCheck[], checks: HealthCheck[] }} report */
export function formatMarkdownReport(report, url) {
  const lines = [
    `# AgentWire production health`,
    ``,
    `**URL:** ${url}`,
    `**Overall:** ${report.ok ? "PASS" : "FAIL"}`,
    ``,
    `## Checks`,
    ``,
    `| Check | Level | Status | Detail |`,
    `| --- | --- | --- | --- |`,
  ];
  for (const check of report.checks) {
    lines.push(
      `| ${check.name} | ${check.level} | ${check.ok ? "ok" : "FAIL"} | ${check.detail.replace(/\|/g, "\\|")} |`,
    );
  }
  if (report.criticalFailed.length) {
    lines.push("", "## Critical failures");
    for (const check of report.criticalFailed) {
      lines.push(`- **${check.name}:** ${check.detail}`);
    }
  }
  if (report.warningFailed.length) {
    lines.push("", "## Warnings");
    for (const check of report.warningFailed) {
      lines.push(`- **${check.name}:** ${check.detail}`);
    }
  }
  return lines.join("\n");
}

async function main() {
  const url = (
    args.url ||
    process.env.RENDER_URL ||
    process.env.PUBLIC_URL ||
    DEFAULT_RENDER_URL
  ).replace(/\/$/, "");

  const report = await runHealthReport(url, {
    mcpApiKey: process.env.MCP_API_KEY,
    renderApiKey: process.env.RENDER_API_KEY,
    failOnWarn: args["fail-on-warn"],
  });

  const payload = {
    url,
    ok: report.ok,
    generatedAt: new Date().toISOString(),
    checks: report.checks,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(formatMarkdownReport(report, url));
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    writeFileSync(summaryPath, formatMarkdownReport(report, url), "utf8");
  }

  if (!report.ok) process.exit(1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
