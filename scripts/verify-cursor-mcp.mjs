#!/usr/bin/env node
/**
 * Verify AgentWire is reachable from Cursor's SSE endpoint.
 *
 * Usage:
 *   npm run verify:cursor-mcp
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const secretsPath = join(repoRoot, ".cursor", "mcp-setup.secrets.json");
const userMcpPath = join(homedir(), ".cursor", "mcp.json");

function loadConfig() {
  if (existsSync(secretsPath)) {
    const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
    const publicUrl =
      secrets.publicUrl?.replace(/\/$/, "") ||
      secrets.renderUrl?.replace(/\/$/, "") ||
      secrets.railwayUrl?.replace(/\/$/, "");
    if (!publicUrl) {
      throw new Error("No publicUrl in mcp-setup.secrets.json. Run npm run setup:cursor-mcp first.");
    }
    return { publicUrl, mcpApiKey: secrets.mcpApiKey };
  }

  if (existsSync(userMcpPath)) {
    const mcp = JSON.parse(readFileSync(userMcpPath, "utf8"));
    const entry = mcp.mcpServers?.["gas-oracle-mcp"];
    if (!entry?.url) {
      throw new Error("gas-oracle-mcp is missing from ~/.cursor/mcp.json. Run npm run setup:cursor-mcp first.");
    }
    const auth = entry.headers?.Authorization || "";
    const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    return {
      publicUrl: entry.url.replace(/\/sse$/, ""),
      mcpApiKey: apiKey,
    };
  }

  throw new Error("No setup found. Run npm run setup:cursor-mcp first.");
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`OK  ${name}`);
    return true;
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message || error}`);
    return false;
  }
}

async function main() {
  const { publicUrl, mcpApiKey } = loadConfig();
  const host = publicUrl.includes("onrender.com") ? "Render" : "Railway";
  console.log(`Checking ${publicUrl} (${host})`);
  console.log("");

  const results = [];

  results.push(
    await check("/health", async () => {
      const res = await fetch(`${publicUrl}/health`, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.status !== "ok") throw new Error(JSON.stringify(body));
    }),
  );

  results.push(
    await check("/ready", async () => {
      const res = await fetch(`${publicUrl}/ready`, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} (CDP/x402 may still be starting)`);
      const body = await res.json();
      if (body.status !== "ready" && body.status !== "degraded") {
        throw new Error(JSON.stringify(body));
      }
    }),
  );

  results.push(
    await check("/sse endpoint deployed (not 404)", async () => {
      const res = await fetch(`${publicUrl}/sse`, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) {
        throw new Error(`404 — redeploy ${host} from latest main (SSE transport not deployed yet)`);
      }
      if (res.status !== 401 && res.status !== 503) {
        throw new Error(`Expected 401 or 503, got ${res.status}`);
      }
    }),
  );

  results.push(
    await check("/sse without API key should be blocked", async () => {
      const res = await fetch(`${publicUrl}/sse`, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) {
        throw new Error(`404 — redeploy ${host} from latest main`);
      }
      if (res.status !== 401) {
        throw new Error(`Expected 401, got ${res.status} (set MCP_API_KEY on ${host} and redeploy)`);
      }
    }),
  );

  results.push(
    await check("/sse with API key", async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${publicUrl}/sse`, {
        headers: { Authorization: `Bearer ${mcpApiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.status === 404) {
        throw new Error(`404 — redeploy ${host} from latest main`);
      }
      if (res.status === 401) {
        throw new Error(`401 — MCP_API_KEY on ${host} must match npm run setup:cursor-mcp / render:provision`);
      }
      if (res.status === 503) {
        throw new Error(`503 — server up but CDP/x402 not ready; check ${host} logs`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        throw new Error(`Expected text/event-stream, got ${contentType}`);
      }
      await res.body?.cancel();
    }),
  );

  console.log("");
  if (results.every(Boolean)) {
    console.log("All checks passed. Restart Cursor and enable gas-oracle-mcp in Settings -> MCP.");
    return;
  }

  console.log("Some checks failed.");
  console.log("Typical fixes:");
  if (host === "Render") {
    console.log("  • RENDER_API_KEY=... npm run render:provision -- --redeploy");
    console.log("  • /ready 503 → check CDP_API_KEY, CDP_PRIVATE_KEY, CDP_WALLET_SECRET in Render Environment");
  } else {
    console.log("  • /sse 404 → Railway → AgentWire → Deployments → Redeploy latest main");
    console.log("  • /sse 401 → Railway Variables: MCP_API_KEY = value from npm run setup:cursor-mcp");
    console.log("  • /ready 503 → check CDP keys in Railway Variables");
  }
  process.exit(1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
