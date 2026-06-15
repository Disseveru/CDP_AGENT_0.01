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
    return JSON.parse(readFileSync(secretsPath, "utf8"));
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
      railwayUrl: entry.url.replace(/\/sse$/, ""),
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
  const { railwayUrl, mcpApiKey } = loadConfig();
  console.log(`Checking ${railwayUrl}`);
  console.log("");

  const results = [];

  results.push(
    await check("/health", async () => {
      const res = await fetch(`${railwayUrl}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.status !== "ok") throw new Error(JSON.stringify(body));
    }),
  );

  results.push(
    await check("/ready", async () => {
      const res = await fetch(`${railwayUrl}/ready`);
      if (!res.ok) throw new Error(`HTTP ${res.status} (CDP/x402 may still be starting)`);
    }),
  );

  results.push(
    await check("/sse without API key should be blocked", async () => {
      const res = await fetch(`${railwayUrl}/sse`);
      if (res.status !== 401) {
        throw new Error(`Expected 401, got ${res.status}`);
      }
    }),
  );

  results.push(
    await check("/sse with API key", async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${railwayUrl}/sse`, {
        headers: { Authorization: `Bearer ${mcpApiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);
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
  console.log("If /health works but /sse fails with 401, add MCP_API_KEY on Railway and redeploy.");
  process.exit(1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
