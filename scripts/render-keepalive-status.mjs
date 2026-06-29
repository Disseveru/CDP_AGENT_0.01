#!/usr/bin/env node
/**
 * Show Cursor-side Render keepalive status (tmux session + last ping).
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const SESSION = "render-keepalive";
const statePath = join(repoRoot, ".cursor", "render-keepalive.json");

const tmux = spawnSync(
  "tmux",
  ["-f", "/exec-daemon/tmux.portal.conf", "has-session", "-t", `=${SESSION}`],
  { encoding: "utf8" },
);
const running = tmux.status === 0;

console.log(`tmux session "${SESSION}": ${running ? "running" : "not running"}`);

if (existsSync(statePath)) {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  console.log(JSON.stringify(state, null, 2));
} else {
  console.log("No .cursor/render-keepalive.json yet. Run: npm run render:keepalive:start");
}

if (!running) {
  process.exit(1);
}
