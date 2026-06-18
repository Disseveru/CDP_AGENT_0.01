import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("sync uses committed skill when remote fetch fails", () => {
  const result = spawnSync(process.execPath, ["scripts/sync-agentic-market-skill.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTIC_MARKET_SKILL_URL: "https://invalid.example.com/SKILL.md",
    },
    encoding: "utf8",
  });

  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /sync skipped/i);
});
