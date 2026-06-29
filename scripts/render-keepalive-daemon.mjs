#!/usr/bin/env node
/**
 * Cursor-side Render keepalive loop (free tier spins down after ~15 min idle).
 * Pings /health and /ready on an interval. Run via:
 *   npm run render:keepalive:daemon
 *   npm run render:keepalive:start   # tmux background (preferred on Cursor Cloud)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const DEFAULT_URL = "https://cdp-agent-0-01.onrender.com";
const INTERVAL_MS = Number(process.env.RENDER_KEEPALIVE_INTERVAL_MS || 4 * 60 * 1000);

function writeState(payload) {
  const cursorDir = join(repoRoot, ".cursor");
  mkdirSync(cursorDir, { recursive: true });
  writeFileSync(
    join(cursorDir, "render-keepalive.json"),
    `${JSON.stringify({ ...payload, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

async function ping(path, baseUrl) {
  const url = `${baseUrl}${path}`;
  const started = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  const ms = Date.now() - started;
  return { path, status: res.status, ms, ok: res.ok || res.status === 402 };
}

async function runOnce(baseUrl) {
  const health = await ping("/health", baseUrl);
  const ready = await ping("/ready", baseUrl);
  const line = `[${new Date().toISOString()}] ${baseUrl} health=${health.status} ready=${ready.status}`;
  console.log(line);
  writeState({
    baseUrl,
    intervalMs: INTERVAL_MS,
    lastHealthStatus: health.status,
    lastReadyStatus: ready.status,
    lastHealthMs: health.ms,
    pid: process.pid,
  });
  if (!health.ok) {
    throw new Error(`Health check failed: HTTP ${health.status}`);
  }
}

async function main() {
  const baseUrl = (process.argv[2] || process.env.RENDER_URL || DEFAULT_URL).replace(/\/$/, "");
  console.log(`Render keepalive daemon → ${baseUrl} (every ${INTERVAL_MS / 1000}s)`);
  writeState({ baseUrl, intervalMs: INTERVAL_MS, pid: process.pid, startedAt: new Date().toISOString() });

  for (;;) {
    try {
      await runOnce(baseUrl);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] keepalive error: ${error.message || error}`);
      writeState({
        baseUrl,
        intervalMs: INTERVAL_MS,
        pid: process.pid,
        lastError: String(error.message || error),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
