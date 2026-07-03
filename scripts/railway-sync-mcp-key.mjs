#!/usr/bin/env node
/**
 * Sync MCP_API_KEY from local Cursor setup secrets to Railway and redeploy.
 *
 * Usage:
 *   npm run setup:cursor-mcp -- https://gas-oracle-mcp-production.up.railway.app
 *   RAILWAY_TOKEN=... npm run railway:sync-mcp-key
 *   RAILWAY_TOKEN=... npm run railway:sync-mcp-key -- --redeploy
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const secretsPath = join(repoRoot, ".cursor", "mcp-setup.secrets.json");

const PROJECT_ID = "2d961fd8-a0a9-4ae6-93e1-3e209858e7f2";
const ENVIRONMENT_ID = "5a065ed8-6c1b-4aa6-8968-7f5f3804c868";
const SERVICE_ID = "0baa1261-4e18-4216-9377-e24e77655561";
const RAILWAY_GRAPHQL = "https://backboard.railway.com/graphql/v2";

const { values: args } = parseArgs({
  options: {
    redeploy: { type: "boolean", default: true },
    restart: { type: "boolean", default: false },
  },
});

function loadMcpApiKey() {
  if (!existsSync(secretsPath)) {
    throw new Error("Missing .cursor/mcp-setup.secrets.json — run npm run setup:cursor-mcp first.");
  }
  const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
  const key = secrets.mcpApiKey?.trim();
  if (!key) {
    throw new Error("mcpApiKey missing in .cursor/mcp-setup.secrets.json");
  }
  return { key, publicUrl: secrets.publicUrl || secrets.railwayUrl };
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
    throw new Error(body.errors.map((error) => error.message).join("; "));
  }
  return body.data;
}

async function upsertMcpKey(token, key) {
  await gql(
    token,
    `mutation($input: VariableUpsertInput!) {
      variableUpsert(input: $input)
    }`,
    {
      input: {
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        serviceId: SERVICE_ID,
        name: "MCP_API_KEY",
        value: key,
        skipDeploys: true,
      },
    },
  );
  console.log("OK  MCP_API_KEY synced to Railway variables");
}

async function redeployMcp(token) {
  await gql(
    token,
    `mutation($environmentId: String!, $serviceId: String!) {
      serviceInstanceDeployV2(environmentId: $environmentId, serviceId: $serviceId)
    }`,
    { environmentId: ENVIRONMENT_ID, serviceId: SERVICE_ID },
  );
  console.log("OK  Triggered MCP redeploy");
}

async function restartLatestDeployment(token) {
  const data = await gql(
    token,
    `query($serviceId: String!, $environmentId: String!) {
      serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
        latestDeployment { id }
      }
    }`,
    { serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID },
  );
  const deploymentId = data.serviceInstance?.latestDeployment?.id;
  if (!deploymentId) {
    throw new Error("No deployment found to restart");
  }
  await gql(
    token,
    `mutation($id: String!) { deploymentRestart(id: $id) }`,
    { id: deploymentId },
  );
  console.log(`OK  Restarted deployment ${deploymentId} (may not reload env vars)`);
}

async function waitForMcpAuth(publicUrl, key, timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${publicUrl.replace(/\/$/, "")}/sse`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 401) {
      console.log(`OK  /sse auth accepted (HTTP ${res.status})`);
      await res.body?.cancel();
      return true;
    }
    await res.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 8_000));
  }
  return false;
}

async function main() {
  const token = process.env.RAILWAY_TOKEN?.trim();
  if (!token) {
    throw new Error("RAILWAY_TOKEN is required.");
  }

  const { key, publicUrl } = loadMcpApiKey();
  console.log("Railway MCP_API_KEY sync");
  console.log(`URL: ${publicUrl}`);
  console.log("");

  await upsertMcpKey(token, key);

  if (args.redeploy) {
    try {
      await redeployMcp(token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`WARN redeploy failed: ${message}`);
      if (args.restart || /resources/i.test(message)) {
        console.log("Trying deploymentRestart (env vars may not refresh until a full redeploy succeeds)...");
        await restartLatestDeployment(token);
      } else {
        throw error;
      }
    }
  }

  if (publicUrl) {
    console.log("");
    console.log("Waiting for /sse to accept the synced MCP_API_KEY...");
    const ready = await waitForMcpAuth(publicUrl, key);
    if (!ready) {
      console.log("");
      console.log("MCP auth still returns 401.");
      console.log("Railway must finish a full redeploy before the running container picks up MCP_API_KEY.");
      console.log("Redeploy manually: Railway → gas-oracle-mcp → Deployments → Redeploy");
      console.log("Then verify: npm run verify:cursor-mcp");
      process.exit(1);
    }
  }

  console.log("");
  console.log("MCP_API_KEY is live. Verify with: npm run verify:cursor-mcp");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
