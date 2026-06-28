#!/usr/bin/env node
/**
 * One-command Cursor MCP setup for AgentWire (Railway or Render).
 *
 * Usage:
 *   npm run setup:cursor-mcp
 *   npm run setup:cursor-mcp -- https://your-app.onrender.com
 *   npm run setup:cursor-mcp -- https://your-app.up.railway.app
 *
 * Writes ~/.cursor/mcp.json (your personal Cursor config, not committed to git).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const projectMcpPath = join(repoRoot, ".cursor", "mcp.json");
const cursorDir = join(homedir(), ".cursor");
const userMcpPath = join(cursorDir, "mcp.json");
const secretsPath = join(repoRoot, ".cursor", "mcp-setup.secrets.json");

function normalizeUrl(input) {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Invalid URL "${input}". Use https://your-app.onrender.com or https://your-app.up.railway.app`);
  }
  return trimmed;
}

function generateApiKey() {
  return randomBytes(32).toString("base64url");
}

function readJson(path, fallback = {}) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function resolvePublicUrl(argvUrl) {
  if (argvUrl) return normalizeUrl(argvUrl);

  const envUrl = process.env.GAS_ORACLE_MCP_URL?.trim() || process.env.RENDER_URL?.trim() || process.env.PUBLIC_URL?.trim();
  if (envUrl) return normalizeUrl(envUrl);

  const secrets = readJson(secretsPath, {});
  const secretUrl = secrets.publicUrl || secrets.renderUrl || secrets.railwayUrl;
  if (secretUrl) return normalizeUrl(secretUrl);

  const urlFile = join(repoRoot, ".cursor", "render-url");
  if (existsSync(urlFile)) {
    const fileUrl = readFileSync(urlFile, "utf8").trim();
    if (fileUrl) return normalizeUrl(fileUrl);
  }

  const railwayFile = join(repoRoot, ".cursor", "railway-url");
  if (existsSync(railwayFile)) {
    const fileUrl = readFileSync(railwayFile, "utf8").trim();
    if (fileUrl) return normalizeUrl(fileUrl);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("");
  console.log("AgentWire Cursor MCP setup");
  console.log("==========================");
  console.log("");
  console.log("Paste your AgentWire public URL (Render or Railway).");
  console.log("Example: https://cdp-agent-0-01.onrender.com");
  console.log("");
  const answer = await rl.question("Public URL: ");
  rl.close();
  return normalizeUrl(answer);
}

function hostingLabel(url) {
  return url.includes("onrender.com") ? "Render" : "Railway";
}

async function main() {
  const argvUrl = process.argv[2];
  const publicUrl = await resolvePublicUrl(argvUrl);
  const apiKey = readJson(secretsPath, {}).mcpApiKey || generateApiKey();
  const host = hostingLabel(publicUrl);

  const projectConfig = readJson(projectMcpPath, { mcpServers: {} });
  const userConfig = readJson(userMcpPath, { mcpServers: {} });

  const gasOracleEntry = {
    type: "sse",
    url: `${publicUrl}/sse`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };

  userConfig.mcpServers = {
    ...userConfig.mcpServers,
    ...projectConfig.mcpServers,
    "gas-oracle-mcp": gasOracleEntry,
  };

  writeJson(userMcpPath, userConfig);
  writeJson(secretsPath, {
    publicUrl,
    renderUrl: publicUrl.includes("onrender.com") ? publicUrl : undefined,
    railwayUrl: publicUrl.includes("railway.app") ? publicUrl : undefined,
    mcpApiKey: apiKey,
    createdAt: new Date().toISOString(),
  });

  console.log("");
  console.log("Done. Cursor config written to:");
  console.log(`  ${userMcpPath}`);
  console.log("");
  console.log(`NEXT: ensure MCP_API_KEY is set on ${host}, then redeploy`);
  console.log("------------------------------------------------");
  if (host === "Render") {
    console.log("  RENDER_API_KEY=... npm run render:provision -- --redeploy");
    console.log("Or Render dashboard → Environment → MCP_API_KEY");
  } else {
    console.log("Railway -> AgentWire service -> Variables -> MCP_API_KEY");
  }
  console.log("");
  console.log(`  Name:  MCP_API_KEY`);
  console.log(`  Value: ${apiKey}`);
  console.log("");
  console.log(`After ${host} finishes redeploying:`);
  console.log("  1. Restart Cursor completely");
  console.log("  2. Open Cursor Settings -> MCP");
  console.log("  3. Turn on gas-oracle-mcp");
  console.log("");
  console.log("Verify with:");
  console.log("  npm run verify:cursor-mcp");
  console.log("");
}

main().catch((error) => {
  console.error("Setup failed:", error.message || error);
  process.exit(1);
});
