import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { computeRenderProvisionUpdates } from "./render-provision.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("computeRenderProvisionUpdates does not touch masked secrets", () => {
  const { updates } = computeRenderProvisionUpdates(
    {
      DATABASE_URL: "",
      MCP_API_KEY: "",
      CDP_API_KEY: "",
      PUBLIC_URL: "https://cdp-agent-0-01.onrender.com",
      NETWORK: "base",
      STORAGE_BACKEND: "postgres",
      FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "587",
    },
    "https://cdp-agent-0-01.onrender.com",
    { generateApiKey: () => "generated-key" },
  );

  assert.ok(!updates.some((entry) => entry.key === "DATABASE_URL"));
  assert.ok(!updates.some((entry) => entry.key === "CDP_API_KEY"));
  assert.ok(!updates.some((entry) => entry.key === "MCP_API_KEY"));
});

test("computeRenderProvisionUpdates generates MCP_API_KEY only when key is absent", () => {
  const { updates, mcpApiKey } = computeRenderProvisionUpdates(
    { PUBLIC_URL: "" },
    "https://cdp-agent-0-01.onrender.com",
    { generateApiKey: () => "generated-key" },
  );

  assert.equal(mcpApiKey, "generated-key");
  assert.ok(updates.some((entry) => entry.key === "MCP_API_KEY" && entry.value === "generated-key"));
});

test("computeRenderProvisionUpdates skips MCP_API_KEY when Render key exists but is masked", () => {
  const { updates, changes } = computeRenderProvisionUpdates(
    { MCP_API_KEY: "", PUBLIC_URL: "https://cdp-agent-0-01.onrender.com" },
    "https://cdp-agent-0-01.onrender.com",
    { generateApiKey: () => "should-not-use" },
  );

  assert.ok(!updates.some((entry) => entry.key === "MCP_API_KEY"));
  assert.ok(changes.some((line) => line.includes("MCP_API_KEY=already set")));
});

test("render-provision uses per-key setEnvVar import, not bulk putEnvVars", () => {
  const source = readFileSync(join(repoRoot, "scripts", "render-provision.mjs"), "utf8");
  assert.match(source, /setEnvVar/);
  assert.doesNotMatch(source, /putEnvVars/);
});
