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

const RAILWAY_GRAPHQL = "https://backboard.railway.com/graphql/v2";

const DEFAULTS = {
  projectId: "2d961fd8-a0a9-4ae6-93e1-3e209858e7f2",
  environmentId: "5a065ed8-6c1b-4aa6-8968-7f5f3804c868",
  mcpServiceId: "0baa1261-4e18-4216-9377-e24e77655561",
  postgresServiceName: "Postgres",
  redisServiceName: "Redis",
  volumeMountPath: "/app/gas-oracle-mcp/data",
  dataDir: "/app/gas-oracle-mcp/data/inboxes",
};

const { values: args } = parseArgs({
  options: {
    redeploy: { type: "boolean", default: false },
    "project-id": { type: "string" },
    "environment-id": { type: "string" },
    "mcp-service-id": { type: "string" },
  },
});

const config = {
  projectId: args["project-id"] || process.env.RAILWAY_PROJECT_ID || DEFAULTS.projectId,
  environmentId:
    args["environment-id"] || process.env.RAILWAY_ENVIRONMENT_ID || DEFAULTS.environmentId,
  mcpServiceId: args["mcp-service-id"] || process.env.RAILWAY_MCP_SERVICE_ID || DEFAULTS.mcpServiceId,
};

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

async function findServiceByName(token, projectId, name) {
  const data = await gql(
    token,
    `query($projectId: String!) {
      project(id: $projectId) {
        services { edges { node { id name } } }
      }
    }`,
    { projectId },
  );
  return data.project.services.edges.find((edge) => edge.node.name === name)?.node;
}

async function ensureRedisService(token) {
  const existing = await findServiceByName(token, config.projectId, DEFAULTS.redisServiceName);
  if (existing) {
    console.log(`Redis service already exists: ${existing.id}`);
    return existing.id;
  }

  const created = await gql(
    token,
    `mutation($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id name }
    }`,
    {
      input: {
        projectId: config.projectId,
        name: DEFAULTS.redisServiceName,
        source: { image: "railwayapp/redis:7.4" },
      },
    },
  );

  const serviceId = created.serviceCreate.id;
  console.log(`Created Redis service: ${serviceId}`);
  return serviceId;
}

async function ensureVolume(token) {
  try {
    const created = await gql(
      token,
      `mutation($input: VolumeCreateInput!) {
        volumeCreate(input: $input) { id name }
      }`,
      {
        input: {
          projectId: config.projectId,
          environmentId: config.environmentId,
          serviceId: config.mcpServiceId,
          mountPath: DEFAULTS.volumeMountPath,
          region: null,
        },
      },
    );
    console.log(`Created volume: ${created.volumeCreate.id} (${created.volumeCreate.name})`);
  } catch (error) {
    if (/already|exists|duplicate/i.test(error.message)) {
      console.log("Volume already attached (or create skipped).");
      return;
    }
    throw error;
  }
}

async function upsertVariable(token, name, value) {
  await gql(
    token,
    `mutation($input: VariableUpsertInput!) {
      variableUpsert(input: $input)
    }`,
    {
      input: {
        projectId: config.projectId,
        environmentId: config.environmentId,
        serviceId: config.mcpServiceId,
        name,
        value,
        skipDeploys: true,
      },
    },
  );
  console.log(`Set ${name}`);
}

async function wireMcpVariables(token, redisServiceName) {
  const variables = [
    ["DATABASE_URL", `\${{${DEFAULTS.postgresServiceName}.DATABASE_URL}}`],
    ["REDIS_URL", `redis://\${{${redisServiceName}.RAILWAY_PRIVATE_DOMAIN}}:6379`],
    ["DATA_DIR", DEFAULTS.dataDir],
    ["STORAGE_BACKEND", "postgres"],
    ["WEBHOOK_RATE_LIMIT", "120"],
    ["WEBHOOK_RATE_WINDOW_SEC", "60"],
  ];

  for (const [name, value] of variables) {
    await upsertVariable(token, name, value);
  }
}

async function redeployMcp(token) {
  await gql(
    token,
    `mutation($environmentId: String!, $serviceId: String!) {
      serviceInstanceDeployV2(environmentId: $environmentId, serviceId: $serviceId)
    }`,
    {
      environmentId: config.environmentId,
      serviceId: config.mcpServiceId,
    },
  );
  console.log("Triggered MCP redeploy.");
}

async function main() {
  const token = process.env.RAILWAY_TOKEN?.trim();
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
  await wireMcpVariables(token, DEFAULTS.redisServiceName);

  const redisInstance = await gql(
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
    await redeployMcp(token);
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
