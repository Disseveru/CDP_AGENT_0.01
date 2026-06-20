#!/usr/bin/env node
/**
 * Diagnose AgentWire on Railway: health, network, MCP auth, and boot-log hints.
 *
 * Usage:
 *   npm run railway:diagnose
 *   RAILWAY_TOKEN=... npm run railway:diagnose
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const secretsPath = join(repoRoot, ".cursor", "mcp-setup.secrets.json");

const RAILWAY_GRAPHQL = "https://backboard.railway.com/graphql/v2";
const PROJECT_ID = "2d961fd8-a0a9-4ae6-93e1-3e209858e7f2";
const ENVIRONMENT_ID = "5a065ed8-6c1b-4aa6-8968-7f5f3804c868";
const SERVICE_ID = "0baa1261-4e18-4216-9377-e24e77655561";

function loadLocalConfig() {
  if (existsSync(secretsPath)) {
    return JSON.parse(readFileSync(secretsPath, "utf8"));
  }
  if (process.env.RAILWAY_URL) {
    return { railwayUrl: process.env.RAILWAY_URL.replace(/\/$/, "") };
  }
  throw new Error("No .cursor/mcp-setup.secrets.json and RAILWAY_URL is unset.");
}

async function gql(token, query, variables) {
  const res = await fetch(RAILWAY_GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  return body.data;
}

function summarizeCredential(name, value) {
  if (!value) return `${name}: missing`;
  const issues = [];
  const trimmed = value.trim();
  if (name.includes("API_KEY") && /\s/.test(trimmed.replace(/^"+|"+$/g, ""))) {
    issues.push("contains whitespace");
  } else if (name.includes("PRIVATE") && /\s/.test(trimmed) && !trimmed.includes("\\n")) {
    issues.push("contains whitespace");
  }
  if (name.includes("PRIVATE") && !value.includes("BEGIN ") && !value.includes("\\n")) {
    issues.push("not PEM or escaped PEM");
  }
  return `${name}: len=${value.length}${issues.length ? ` (${issues.join(", ")})` : " (ok format)"}`;
}

async function main() {
  const { railwayUrl, mcpApiKey } = loadLocalConfig();
  console.log(`AgentWire Railway diagnose`);
  console.log(`URL: ${railwayUrl}`);
  console.log("");

  const healthRes = await fetch(`${railwayUrl}/health`);
  const health = await healthRes.json();
  console.log(`health: ${healthRes.status} status=${health.status} network=${health.network}`);
  if (health.storage) {
    console.log(`storage: backend=${health.storage.backend} ok=${health.storage.ok}`);
  }
  if (health.redis) {
    console.log(`redis: ok=${health.redis.ok}${health.redis.detail ? ` (${health.redis.detail})` : ""}`);
  }

  const readyRes = await fetch(`${railwayUrl}/ready`);
  const ready = await readyRes.json();
  console.log(
    `ready:  ${readyRes.status} status=${ready.status} payments=${ready.paymentsAvailable ?? "?"}`,
  );

  const sseNoAuth = await fetch(`${railwayUrl}/sse`);
  console.log(`sse (no key): ${sseNoAuth.status}`);

  if (mcpApiKey) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const sseAuth = await fetch(`${railwayUrl}/sse`, {
      headers: { Authorization: `Bearer ${mcpApiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    console.log(`sse (key):  ${sseAuth.status} ${sseAuth.headers.get("content-type") || ""}`);
    await sseAuth.body?.cancel();
  } else {
    console.log("sse (key):  skipped (no local MCP API key)");
  }

  const discovery = await fetch(`${railwayUrl}/`);
  console.log(`discovery GET /: ${discovery.status} (402 is normal on Base mainnet)`);

  const token = process.env.RAILWAY_TOKEN?.trim();
  if (!token) {
    console.log("");
    console.log("Set RAILWAY_TOKEN to also fetch Railway variables and boot logs.");
    return;
  }

  console.log("");
  console.log("Railway variables (format only, values hidden):");

  const data = await gql(
    token,
    `query($projectId: String!, $environmentId: String!, $serviceId: String!) {
      variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
      deployments(input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId }, first: 1) {
        edges { node { id status createdAt } }
      }
    }`,
    { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID, serviceId: SERVICE_ID },
  );

  const vars = data.variables || {};
  for (const key of ["NETWORK", "FACILITATOR_URL", "MCP_API_KEY", "PAY_TO_ADDRESS", "STORAGE_BACKEND", "DATA_DIR"]) {
    if (key === "MCP_API_KEY") {
      console.log(`MCP_API_KEY: ${vars.MCP_API_KEY ? "set" : "missing"}`);
      continue;
    }
    console.log(`${key}: ${vars[key] || "(unset)"}`);
  }
  for (const key of ["DATABASE_URL", "REDIS_URL"]) {
    console.log(`${key}: ${vars[key] ? "set (reference)" : "missing"}`);
  }
  for (const key of ["CDP_API_KEY", "CDP_PRIVATE_KEY", "CDP_WALLET_SECRET"]) {
    console.log(summarizeCredential(key, vars[key]));
  }

  const tsxPath = join(repoRoot, "gas-oracle-mcp", "node_modules", ".bin", "tsx");
  const diag = spawnSync(
    tsxPath,
    [
      "--input-type=module",
      "-e",
      `process.env.CDP_API_KEY = ${JSON.stringify(vars.CDP_API_KEY || "")};
       process.env.CDP_PRIVATE_KEY = ${JSON.stringify(vars.CDP_PRIVATE_KEY || "")};
       const { diagnoseCdpApiCredentials } = await import("./gas-oracle-mcp/src/wallet.ts");
       console.log(diagnoseCdpApiCredentials().issue);`,
    ],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
  );
  const issue = diag.stdout.trim().split("\n").at(-1);
  if (issue) {
    console.log(`CDP facilitator credential check: ${issue}`);
    if (issue === "invalid_private_key") {
      console.log("  → Re-paste CDP_PRIVATE_KEY in Railway as a single line with \\n escapes.");
    }
    if (issue === "missing_api_key_id" || issue === "missing_private_key") {
      console.log("  → Set CDP_API_KEY and CDP_PRIVATE_KEY (or CDP_API_KEY_ID / CDP_API_KEY_SECRET).");
    }
  }

  const deploymentId = data.deployments?.edges?.[0]?.node?.id;
  if (!deploymentId) return;

  const logsData = await gql(
    token,
    `query($deploymentId: String!, $limit: Int) {
      deploymentLogs(deploymentId: $deploymentId, limit: $limit) { message }
    }`,
    { deploymentId, limit: 50 },
  );

  const bootIssues = (logsData.deploymentLogs || [])
    .map((l) => l.message)
    .filter((m) => /error|failed|unavailable|401/i.test(m));

  if (bootIssues.length) {
    console.log("");
    console.log("Recent boot warnings/errors:");
    for (const line of bootIssues.slice(-8)) {
      console.log(`  ${line}`);
    }
    console.log("");
    console.log("If CDP credentials show whitespace issues, re-paste them in Railway → Variables.");
    console.log("Use single-line PEM with \\n escapes for CDP_PRIVATE_KEY.");
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
