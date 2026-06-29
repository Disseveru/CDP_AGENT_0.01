#!/usr/bin/env node
/**
 * Start Render keepalive in a tmux session (Cursor Cloud — no GitHub Actions needed).
 *
 * Usage:
 *   npm run render:keepalive:start
 *   RENDER_KEEPALIVE=0 npm run bootstrap:agent   # skip auto-start
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const SESSION = "render-keepalive";
const TMUX = ["tmux", "-f", "/exec-daemon/tmux.portal.conf"];

function tmux(args) {
  return spawnSync(TMUX[0], [...TMUX.slice(1), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
}

function sessionRunning() {
  const result = tmux(["has-session", "-t", `=${SESSION}`]);
  return result.status === 0;
}

function readState() {
  const statePath = join(repoRoot, ".cursor", "render-keepalive.json");
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  if (process.env.RENDER_KEEPALIVE === "0" || process.env.RENDER_KEEPALIVE === "false") {
    console.log("Render keepalive skipped (RENDER_KEEPALIVE=0).");
    return;
  }

  if (sessionRunning()) {
    const state = readState();
    console.log(`Render keepalive already running (tmux session: ${SESSION}).`);
    if (state?.updatedAt) {
      console.log(`  Last ping: ${state.updatedAt} health=${state.lastHealthStatus} ready=${state.lastReadyStatus}`);
    }
    return;
  }

  const daemon = join(repoRoot, "scripts", "render-keepalive-daemon.mjs");
  const create = tmux([
    "new-session",
    "-d",
    "-s",
    SESSION,
    "-c",
    repoRoot,
    "--",
    process.execPath,
    daemon,
  ]);

  if (create.status !== 0) {
    const err = (create.stderr || create.stdout || "").trim();
    throw new Error(`Failed to start tmux keepalive: ${err || "unknown error"}`);
  }

  console.log(`Started Render keepalive in tmux session "${SESSION}".`);
  console.log("  npm run render:keepalive        # one-shot ping");
  console.log("  npm run render:keepalive:status # check last ping");
  console.log(`  tmux -f /exec-daemon/tmux.portal.conf attach -t ${SESSION}  # view logs`);
}

main();
