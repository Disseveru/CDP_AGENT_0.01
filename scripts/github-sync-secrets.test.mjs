import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("secrets manifest lists operational keys for GitHub sync", () => {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, ".github", "secrets-manifest.json"), "utf8"),
  );
  assert.ok(manifest.secrets.includes("RENDER_API_KEY"));
  assert.ok(manifest.secrets.includes("MCP_API_KEY"));
  assert.ok(manifest.secrets.includes("CDP_API_KEY"));
  assert.ok(manifest.secrets.includes("DSA_PRIVATE_KEY"));
  assert.ok(manifest.secrets.includes("MNEMONIC_PHRASE"));
  assert.ok(manifest.envAliases.SMTP_PASS.includes("SMTH_PASS"));
  assert.ok(manifest.envAliases.DSA_PRIVATE_KEY.includes("EOA_PRIVATE_KEY"));
  assert.equal(manifest.variables.RENDER_URL, "https://cdp-agent-0-01.onrender.com");
});
