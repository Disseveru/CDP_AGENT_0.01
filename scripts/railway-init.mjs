#!/usr/bin/env node
/**
 * Bootstrap AgentWire on a new (or existing) Railway account.
 *
 * Operator steps (one time):
 *   1. Create account at railway.com and connect GitHub (authorize Disseveru/CDP_AGENT_0.01)
 *   2. Create an API token at railway.com/account/tokens → add to Cursor secrets as RAILWAY_TOKEN
 *
 * Agent / local:
 *   RAILWAY_TOKEN=... npm run railway:init
 *   RAILWAY_TOKEN=... npm run railway:init -- --create-project
 *   RAILWAY_TOKEN=... npm run railway:init -- --project-id <uuid> --redeploy
 *
 * Writes .cursor/railway-project.json and prints the public URL for Cursor MCP setup.
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

import { fileURLToPath } from "node:url";

import {
  LEGACY_RAILWAY_DEFAULTS,
  createProjectFromRepo,
  createService,
  ensureServiceDomain,
  findServiceByName,
  getProductionEnvironmentId,
  getProject,
  getRailwayToken,
  getServiceVariables,
  listProjects,
  loadRailwayConfig,
  railwayGql,
  railwayProjectConfigPath,
  redeployService,
  saveRailwayConfig,
  upsertVariable,
} from "./railway-api.mjs";

const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

const { values: args } = parseArgs({
  options: {
    "create-project": { type: "boolean", default: false },
    "project-id": { type: "string" },
    "project-name": { type: "string", default: "agentwire" },
    redeploy: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    discover: { type: "boolean", default: false },
  },
});

function generateApiKey() {
  return randomBytes(32).toString("base64url");
}

function log(step, message) {
  console.log(`${step}  ${message}`);
}

async function ensurePostgresService(token, config) {
  const existing = await findServiceByName(token, config.projectId, config.postgresServiceName);
  if (existing) {
    log("OK", `Postgres service exists: ${existing.id}`);
    return existing.id;
  }
  if (args["dry-run"]) {
    log("DRY", `Would create Postgres service (${config.postgresImage})`);
    return "dry-run-postgres";
  }
  const created = await createService(token, {
    projectId: config.projectId,
    environmentId: config.environmentId,
    name: config.postgresServiceName,
    image: config.postgresImage,
  });
  log("OK", `Created Postgres service: ${created.id}`);
  return created.id;
}

async function ensureRedisService(token, config) {
  const existing = await findServiceByName(token, config.projectId, config.redisServiceName);
  if (existing) {
    log("OK", `Redis service exists: ${existing.id}`);
    return existing.id;
  }
  if (args["dry-run"]) {
    log("DRY", `Would create Redis service (${config.redisImage})`);
    return "dry-run-redis";
  }
  const created = await createService(token, {
    projectId: config.projectId,
    environmentId: config.environmentId,
    name: config.redisServiceName,
    image: config.redisImage,
  });
  log("OK", `Created Redis service: ${created.id}`);
  return created.id;
}

async function findMcpService(token, config) {
  const project = await getProject(token, config.projectId);
  const byId = project.services.edges.find((edge) => edge.node.id === config.mcpServiceId)?.node;
  if (byId) return byId;

  const preferredNames = [config.mcpServiceName, "gas-oracle-mcp", "AgentWire", "CDP_AGENT_0.01"];
  for (const name of preferredNames) {
    const match = project.services.edges.find((edge) => edge.node.name === name)?.node;
    if (match) return match;
  }

  const repoService = project.services.edges.find((edge) => {
    const n = edge.node.name.toLowerCase();
    return n.includes("cdp") || n.includes("agent") || n.includes("gas-oracle");
  })?.node;

  return repoService || project.services.edges[0]?.node;
}

async function ensureVolume(token, config) {
  const data = await railwayGql(
    token,
    `query($environmentId: String!) {
      environment(id: $environmentId) {
        volumeInstances {
          edges {
            node {
              serviceId mountPath state volume { name }
            }
          }
        }
      }
    }`,
    { environmentId: config.environmentId },
  );

  const mounted = data.environment.volumeInstances.edges.find(
    (edge) =>
      edge.node.serviceId === config.mcpServiceId &&
      edge.node.mountPath === config.volumeMountPath &&
      edge.node.state !== "FAILED",
  );
  if (mounted) {
    log("OK", `Volume mounted: ${mounted.node.volume.name}`);
    return;
  }
  if (args["dry-run"]) {
    log("DRY", `Would create volume at ${config.volumeMountPath}`);
    return;
  }

  try {
    const created = await railwayGql(
      token,
      `mutation($input: VolumeCreateInput!) {
        volumeCreate(input: $input) { id name }
      }`,
      {
        input: {
          projectId: config.projectId,
          environmentId: config.environmentId,
          serviceId: config.mcpServiceId,
          mountPath: config.volumeMountPath,
          region: null,
        },
      },
    );
    log("OK", `Created volume: ${created.volumeCreate.id}`);
  } catch (error) {
    if (/already|exists|duplicate|only have one volume/i.test(error.message)) {
      log("OK", "Volume already attached (skipped).");
      return;
    }
    throw error;
  }
}

/**
 * @param {Record<string, string>} existingVars
 * @param {ReturnType<typeof loadRailwayConfig>} config
 * @param {string} publicUrl
 */
export function computeRailwayInitUpdates(existingVars, config, publicUrl) {
  /** @type {{ name: string, value: string }[]} */
  const updates = [];
  const changes = [];

  const hasMcpKey = Object.prototype.hasOwnProperty.call(existingVars, "MCP_API_KEY");
  if (!hasMcpKey) {
    updates.push({ name: "MCP_API_KEY", value: generateApiKey() });
    changes.push("MCP_API_KEY=generated");
  } else if (!existingVars.MCP_API_KEY?.trim()) {
    changes.push("MCP_API_KEY=already set (kept)");
  } else {
    changes.push("MCP_API_KEY=already set (kept)");
  }

  const staticPairs = [
    ["DATABASE_URL", `\${{${config.postgresServiceName}.DATABASE_URL}}`],
    ["REDIS_URL", `redis://\${{${config.redisServiceName}.RAILWAY_PRIVATE_DOMAIN}}:6379`],
    ["DATA_DIR", config.dataDir],
    ["STORAGE_BACKEND", "postgres"],
    ["WEBHOOK_RATE_LIMIT", "120"],
    ["WEBHOOK_RATE_WINDOW_SEC", "60"],
    ["NETWORK", "base"],
    ["FACILITATOR_URL", CDP_FACILITATOR_URL],
    ["PUBLIC_URL", publicUrl],
    ["SMTP_HOST", "smtp.gmail.com"],
    ["SMTP_PORT", "587"],
  ];

  for (const [name, value] of staticPairs) {
    if (!existingVars[name]?.trim()) {
      updates.push({ name, value });
      changes.push(`${name}=${value}`);
    }
  }

  const secretEnv = [
    ["CDP_API_KEY", "CDP_API_KEY"],
    ["CDP_API_KEY_ID", "CDP_API_KEY_ID"],
    ["CDP_PRIVATE_KEY", "CDP_PRIVATE_KEY"],
    ["CDP_API_KEY_SECRET", "CDP_API_KEY_SECRET"],
    ["CDP_WALLET_SECRET", "CDP_WALLET_SECRET"],
    ["PAY_TO_ADDRESS", "PAY_TO_ADDRESS"],
    ["OPERATOR_SMS_NUMBER", "OPERATOR_SMS_NUMBER"],
    ["OPERATOR_EMAIL", "OPERATOR_EMAIL"],
    ["SMTP_PASS", "SMTP_PASS"],
    ["TWILIO_ACCOUNT_SID", "TWILIO_ACCOUNT_SID"],
    ["TWILIO_AUTH_TOKEN", "TWILIO_AUTH_TOKEN"],
    ["TWILIO_FROM_NUMBER", "TWILIO_FROM_NUMBER"],
  ];

  for (const [varName, envName] of secretEnv) {
    const local = process.env[envName]?.trim();
    if (local && !existingVars[varName]?.trim()) {
      updates.push({ name: varName, value: local });
      changes.push(`${varName}=from local env`);
    }
  }

  return { updates, changes };
}

async function applyInitUpdates(token, config, publicUrl) {
  const existingVars = await getServiceVariables(token, config);
  const { updates, changes } = computeRailwayInitUpdates(existingVars, config, publicUrl);

  if (!updates.length) {
    log("OK", "All MCP variables already configured.");
    return;
  }

  for (const change of changes) {
    log("SET", change);
  }

  if (args["dry-run"]) {
    log("DRY", `Would upsert ${updates.length} variable(s)`);
    return;
  }

  for (const { name, value } of updates) {
    await upsertVariable(token, config, name, value);
  }
}

async function resolveProject(token) {
  if (args["project-id"]) {
    const project = await getProject(token, args["project-id"]);
    log("OK", `Using project: ${project.name} (${project.id})`);
    return project;
  }

  const projects = await listProjects(token);
  if (!projects.length || args["create-project"]) {
    if (args["dry-run"]) {
      log("DRY", `Would create project "${args["project-name"]}" from ${LEGACY_RAILWAY_DEFAULTS.githubRepo}`);
      return {
        id: "dry-run-project",
        name: args["project-name"],
        environments: { edges: [{ node: { id: "dry-run-env", name: "production" } }] },
        services: { edges: [] },
      };
    }
    const created = await createProjectFromRepo(token, {
      name: args["project-name"],
      githubRepo: LEGACY_RAILWAY_DEFAULTS.githubRepo,
    });
    log("OK", `Created project: ${created.name} (${created.id})`);
    return getProject(token, created.id);
  }

  const preferred =
    projects.find((p) => /agentwire|gas-oracle|cdp/i.test(p.name)) || projects[0];
  log("OK", `Using existing project: ${preferred.name} (${preferred.id})`);
  return getProject(token, preferred.id);
}

async function waitForHealth(publicUrl, timeoutMs = 300_000) {
  const url = publicUrl.replace(/\/$/, "");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const body = await res.json();
        if (body.status === "ok") {
          log("OK", `Health check passed: ${url}/health`);
          return true;
        }
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  return false;
}

async function main() {
  const token = getRailwayToken();
  if (!token) {
    throw new Error("RAILWAY_TOKEN is required. Create one at railway.com/account/tokens.");
  }

  console.log("AgentWire Railway init");
  console.log("======================");
  console.log("");

  let config = loadRailwayConfig({
    projectId: args["project-id"],
    projectName: args["project-name"],
  });

  const project = await resolveProject(token);
  config = {
    ...config,
    projectId: project.id,
    projectName: project.name,
    environmentId: await getProductionEnvironmentId(project),
  };

  const mcp = await findMcpService(token, config);
  if (!mcp) {
    throw new Error(
      "No MCP service found. In Railway dashboard: New → GitHub Repo → select this repo, then re-run railway:init.",
    );
  }
  config.mcpServiceId = mcp.id;
  config.mcpServiceName = mcp.name;
  log("OK", `MCP service: ${mcp.name} (${mcp.id})`);

  await ensurePostgresService(token, config);
  await ensureRedisService(token, config);
  await ensureVolume(token, config);

  let publicUrl = config.publicUrl;
  if (!args["dry-run"]) {
    const domain = await ensureServiceDomain(token, config.environmentId, config.mcpServiceId);
    publicUrl = `https://${domain}`;
    log("OK", `Public URL: ${publicUrl}`);
  } else {
    log("DRY", `Would ensure public domain for service ${config.mcpServiceId}`);
  }

  await applyInitUpdates(token, config, publicUrl);

  if (!args["dry-run"]) {
    saveRailwayConfig({ ...config, publicUrl });
    log("OK", `Wrote ${railwayProjectConfigPath}`);
  }

  if (args.redeploy && !args["dry-run"]) {
    await redeployService(token, config);
    log("OK", "Triggered MCP redeploy.");
    console.log("");
    console.log("Waiting for /health (up to 5 min)...");
    const healthy = await waitForHealth(publicUrl);
    if (!healthy) {
      console.log("WARN  Service not healthy yet — check Railway deploy logs.");
    }
  } else if (!args["dry-run"]) {
    console.log("");
    console.log("Redeploy to apply variables:");
    console.log("  npm run railway:init -- --redeploy");
    console.log("  # or: npm run railway:provision -- --redeploy");
  }

  console.log("");
  console.log("Next steps");
  console.log("----------");
  console.log(`1. Cursor MCP setup:  npm run setup:cursor-mcp -- ${publicUrl}`);
  console.log("2. Sync MCP key:      RAILWAY_TOKEN=... npm run railway:sync-mcp-key");
  console.log("3. Verify:            npm run verify:cursor-mcp");
  console.log("4. GitHub secrets:    npm run github:sync-secrets -- --apply");
  console.log("");
  console.log("Full guide: docs/RAILWAY-DEPLOY.md");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
