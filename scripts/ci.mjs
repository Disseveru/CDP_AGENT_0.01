#!/usr/bin/env node
/**
 * Cursor-native CI — mirrors .github/workflows/ci.yml for Cloud Agents and local dev.
 *
 * Usage:
 *   npm run ci
 *
 * Cloud Agents: run before every commit/push/PR update.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const mcpDir = join(repoRoot, "gas-oracle-mcp");

function run(label, command, args, options = {}) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    console.error(`\nCI FAILED at: ${label}`);
    process.exit(result.status ?? 1);
  }
}

console.log("Cursor CI — root CLI + AgentWire MCP");

run("Install root dependencies", "npm", ["install"]);
run("Test root CLI", "npm", ["test"]);
run("Install AgentWire dependencies", "npm", ["install", "--legacy-peer-deps"], { cwd: mcpDir });
run("Build AgentWire", "npm", ["run", "build"], { cwd: mcpDir });
run("Test AgentWire", "npm", ["test"], { cwd: mcpDir });

console.log("\nCI PASSED");
