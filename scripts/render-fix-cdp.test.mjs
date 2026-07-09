import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { computeRenderCdpFixUpdates } from "./render-fix-cdp.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const local = {
  apiKeyId: "key-id",
  privateKeyOneLine: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
  walletSecret: "wallet-secret",
};

test("computeRenderCdpFixUpdates returns only CDP keys, not masked Render secrets", () => {
  const updates = computeRenderCdpFixUpdates(
    {
      DATABASE_URL: "",
      MCP_API_KEY: "",
      REDIS_URL: "",
      PUBLIC_URL: "https://cdp-agent-0-01.onrender.com",
    },
    { local, serviceUrl: "https://cdp-agent-0-01.onrender.com" },
  );

  assert.deepEqual(
    updates.map((entry) => entry.key),
    ["CDP_API_KEY", "CDP_PRIVATE_KEY", "CDP_WALLET_SECRET", "PAY_TO_ADDRESS", "FACILITATOR_URL", "NETWORK"],
  );
  assert.ok(!updates.some((entry) => entry.key === "DATABASE_URL"));
});

test("computeRenderCdpFixUpdates fills PUBLIC_URL only when Render value is empty", () => {
  const updates = computeRenderCdpFixUpdates(
    { PUBLIC_URL: "" },
    { local, serviceUrl: "https://cdp-agent-0-01.onrender.com" },
  );

  assert.ok(updates.some((entry) => entry.key === "PUBLIC_URL"));
});

test("computeRenderCdpFixUpdates skips PUBLIC_URL when Render already has it", () => {
  const updates = computeRenderCdpFixUpdates(
    { PUBLIC_URL: "https://existing.onrender.com" },
    { local, serviceUrl: "https://cdp-agent-0-01.onrender.com" },
  );

  assert.ok(!updates.some((entry) => entry.key === "PUBLIC_URL"));
});

test("render-fix-cdp uses per-key setEnvVar import, not bulk putEnvVars", () => {
  const source = readFileSync(join(repoRoot, "scripts", "render-fix-cdp.mjs"), "utf8");
  assert.match(source, /setEnvVar/);
  assert.doesNotMatch(source, /putEnvVars/);
});
