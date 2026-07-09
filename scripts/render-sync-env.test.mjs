import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { computeRenderSyncUpdates } from "./render-sync-env.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("computeRenderSyncUpdates only returns explicit local overrides", () => {
  const updates = computeRenderSyncUpdates(
    {
      DATABASE_URL: "",
      MCP_API_KEY: "",
      REDIS_URL: "",
      CDP_API_KEY: "",
      PUBLIC_URL: "https://cdp-agent-0-01.onrender.com",
    },
    {
      resolveEnv: (name) => (name === "CDP_API_KEY" ? "local-key-id" : undefined),
      serviceUrl: "https://cdp-agent-0-01.onrender.com",
    },
  );

  assert.deepEqual(updates, [
    { key: "CDP_API_KEY", value: "local-key-id", reason: "CDP_API_KEY=updated (12 chars)" },
  ]);
});

test("computeRenderSyncUpdates skips keys that already match Render", () => {
  const updates = computeRenderSyncUpdates(
    {
      CDP_API_KEY: "same-key",
      SMTP_PASS: "",
      PUBLIC_URL: "https://cdp-agent-0-01.onrender.com",
    },
    {
      resolveEnv: (name) => (name === "CDP_API_KEY" ? "same-key" : undefined),
      serviceUrl: "https://cdp-agent-0-01.onrender.com",
    },
  );

  assert.equal(updates.length, 0);
});

test("computeRenderSyncUpdates fills PUBLIC_URL only when Render value is empty", () => {
  const updates = computeRenderSyncUpdates(
    { PUBLIC_URL: "", DATABASE_URL: "" },
    {
      resolveEnv: () => undefined,
      serviceUrl: "https://cdp-agent-0-01.onrender.com",
    },
  );

  assert.deepEqual(updates, [
    {
      key: "PUBLIC_URL",
      value: "https://cdp-agent-0-01.onrender.com",
      reason: "PUBLIC_URL=https://cdp-agent-0-01.onrender.com",
    },
  ]);
});

test("render-sync-env uses per-key setEnvVar import, not bulk putEnvVars", () => {
  const source = readFileSync(join(repoRoot, "scripts", "render-sync-env.mjs"), "utf8");
  assert.match(source, /setEnvVar/);
  assert.doesNotMatch(source, /putEnvVars/);
});
