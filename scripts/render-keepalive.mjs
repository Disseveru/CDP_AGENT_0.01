#!/usr/bin/env node
/**
 * Ping AgentWire on Render to prevent free-tier spin-down (15 min idle).
 *
 * Usage:
 *   npm run render:keepalive
 *   npm run render:keepalive -- https://cdp-agent-0-01.onrender.com
 */
const DEFAULT_URL = "https://cdp-agent-0-01.onrender.com";

async function ping(path, baseUrl) {
  const url = `${baseUrl}${path}`;
  const started = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  const ms = Date.now() - started;
  console.log(`${path}: HTTP ${res.status} (${ms}ms)`);
  return res.ok || res.status === 402;
}

async function main() {
  const baseUrl = (process.argv[2] || process.env.RENDER_URL || DEFAULT_URL).replace(/\/$/, "");
  console.log(`Render keepalive → ${baseUrl}`);

  const healthOk = await ping("/health", baseUrl);
  const readyRes = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(120_000) });
  console.log(`/ready: HTTP ${readyRes.status}`);

  if (!healthOk) {
    throw new Error("Health check failed");
  }
  console.log("Done.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
