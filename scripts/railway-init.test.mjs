import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateRailwayEnv } from "./railway-api.mjs";
import { computeRailwayInitUpdates } from "./railway-init.mjs";

test("evaluateRailwayEnv flags missing secrets", () => {
  const checks = evaluateRailwayEnv({ NETWORK: "base", DATABASE_URL: "postgres://x" });
  assert.ok(checks.some((c) => c.name === "railway_env_mcp_api_key" && !c.ok));
  assert.ok(checks.some((c) => c.name === "railway_env_cdp_api_key" && !c.ok));
  assert.ok(checks.some((c) => c.name === "railway_env_redis_url" && !c.ok));
});

test("computeRailwayInitUpdates generates MCP key when absent", () => {
  const config = {
    postgresServiceName: "Postgres",
    redisServiceName: "Redis",
    dataDir: "/app/gas-oracle-mcp/data/inboxes",
  };
  const { updates, changes } = computeRailwayInitUpdates({}, config, "https://test.up.railway.app");
  assert.ok(updates.some((u) => u.name === "MCP_API_KEY"));
  assert.ok(changes.some((c) => c.includes("MCP_API_KEY=generated")));
  assert.ok(updates.some((u) => u.name === "DATABASE_URL" && u.value.includes("Postgres")));
  assert.ok(updates.some((u) => u.name === "PUBLIC_URL" && u.value === "https://test.up.railway.app"));
});

test("computeRailwayInitUpdates keeps existing MCP_API_KEY", () => {
  const config = {
    postgresServiceName: "Postgres",
    redisServiceName: "Redis",
    dataDir: "/app/data",
  };
  const { updates, changes } = computeRailwayInitUpdates(
    { MCP_API_KEY: "existing-key", NETWORK: "base", DATABASE_URL: "x", REDIS_URL: "y" },
    config,
    "https://test.up.railway.app",
  );
  assert.ok(!updates.some((u) => u.name === "MCP_API_KEY"));
  assert.ok(changes.some((c) => c.includes("MCP_API_KEY=already set")));
});
