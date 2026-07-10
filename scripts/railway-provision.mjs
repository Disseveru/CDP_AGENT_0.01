#!/usr/bin/env node
/**
 * Provision Railway services for AgentWire production:
 * - Persistent volume for file-backed inbox fallback
 * - Redis for webhook rate limiting
 * - Reference variables wiring Postgres + Redis into gas-oracle-mcp
 *
 * Usage:
 *   RAILWAY_TOKEN=... npm run railway:provision
 *   RAILWAY_TOKEN=... npm run railway:provision -- --redeploy
 */
import { parseArgs } from "node:util";

import {
  createService,
  findServiceByName,
  getRailwayToken,
  loadRailwayConfig,
  railwayGql,
  redeployService,
  upsertVariable,
} from "./railway-api.mjs";

const { values: args } = parseArgs({
  options: {
    redeploy: { type: "boolean", default: false },
    "project-id": { type: "string" },
    "environment-id": { type: "string" },
    "mcp-service-id": { type: "string" },
  },
});

const config = loadRailwayConfig({
  projectId: args["project-id"],
  environmentId: args["environment-id"],
  mcpServiceId: args["mcp-service-id"],
});

async function ensureRedisService(token) {
  const existing = await findServiceByName(token, config.projectId, config.redisServiceName);
  if (existing) {
    console.log(`Redis service already exists: ${existing.id}`);
    return existing.id;
  }

  const created = await createService(token, {
    projectId: config.projectId,
    environmentId: config.environmentId,
    name: config.redisServiceName,
    image: config.redisImage,
  });
  console.log(`Created Redis service: ${created.id}`);
  return created.id;
}

async function hasMcpVolumeMount(token) {
  const data = await railwayGql(
    token,
    `query($environmentId: String!) {
      environment(id: $environmentId) {
        volumeInstances {
          edges {
            node {
              serviceId
              mountPath
              state
              volume { name }
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
    console.log(
      `MCP volume already mounted: ${mounted.node.volume.name} at ${mounted.node.mountPath}`,
    );
    return true;
  }
  return false;
}

async function ensureVolume(token) {
  if (await hasMcpVolumeMount(token)) {
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
    console.log(`Created volume: ${created.volumeCreate.id} (${created.volumeCreate.name})`);
  } catch (error) {
    if (/already|exists|duplicate|only have one volume/i.test(error.message)) {
      console.log("Volume already attached (or create skipped).");
      return;
    }
    throw error;
  }
}

async function wireMcpVariables(token) {
  const variables = [
    ["DATABASE_URL", `\${{${config.postgresServiceName}.DATABASE_URL}}`],
    ["REDIS_URL", `redis://\${{${config.redisServiceName}.RAILWAY_PRIVATE_DOMAIN}}:6379`],
    ["DATA_DIR", config.dataDir],
    ["STORAGE_BACKEND", "postgres"],
    ["WEBHOOK_RATE_LIMIT", "120"],
    ["WEBHOOK_RATE_WINDOW_SEC", "60"],
  ];

  for (const [name, value] of variables) {
    await upsertVariable(token, config, name, value);
    console.log(`Set ${name}`);
  }
}

async function main() {
  const token = getRailwayToken();
  if (!token) {
    throw new Error("RAILWAY_TOKEN is required.");
  }

  console.log("AgentWire Railway provision");
  console.log(`Project:     ${config.projectId}`);
  console.log(`Environment: ${config.environmentId}`);
  console.log(`MCP service: ${config.mcpServiceId}`);
  console.log("");

  const redisServiceId = await ensureRedisService(token);
  await ensureVolume(token);
  await wireMcpVariables(token);

  const redisInstance = await railwayGql(
    token,
    `query($serviceId: String!, $environmentId: String!) {
      serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
        latestDeployment { status }
      }
    }`,
    { serviceId: redisServiceId, environmentId: config.environmentId },
  );
  console.log(`Redis deployment: ${redisInstance.serviceInstance?.latestDeployment?.status || "pending"}`);

  if (args.redeploy) {
    await redeployService(token, config);
    console.log("Triggered MCP redeploy.");
  } else {
    console.log("");
    console.log("Variables updated with skipDeploys=true. Redeploy MCP to apply:");
    console.log("  npm run railway:provision -- --redeploy");
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
