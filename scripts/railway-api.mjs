/**
 * Shared Railway GraphQL helpers and project configuration.
 *
 * Project IDs are loaded from (highest priority first):
 *   1. CLI flags / explicit options
 *   2. Environment: RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_MCP_SERVICE_ID
 *   3. .cursor/railway-project.json (written by railway:init)
 *   4. Built-in defaults for the legacy confident-amazement project
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(__dirname, "..");
export const railwayProjectConfigPath = join(repoRoot, ".cursor", "railway-project.json");

export const RAILWAY_GRAPHQL = "https://backboard.railway.com/graphql/v2";

/** Legacy production project (confident-amazement). */
export const LEGACY_RAILWAY_DEFAULTS = {
  projectId: "2d961fd8-a0a9-4ae6-93e1-3e209858e7f2",
  environmentId: "5a065ed8-6c1b-4aa6-8968-7f5f3804c868",
  mcpServiceId: "0baa1261-4e18-4216-9377-e24e77655561",
  publicUrl: "https://gas-oracle-mcp-production.up.railway.app",
  postgresServiceName: "Postgres",
  redisServiceName: "Redis",
  mcpServiceName: "gas-oracle-mcp",
  volumeMountPath: "/app/gas-oracle-mcp/data",
  dataDir: "/app/gas-oracle-mcp/data/inboxes",
  postgresImage: "ghcr.io/railwayapp-templates/postgres-ssl:18.4",
  redisImage: "railwayapp/redis:7.4",
  githubRepo: "Disseveru/CDP_AGENT_0.01",
};

/**
 * @param {Partial<typeof LEGACY_RAILWAY_DEFAULTS> & { projectName?: string }} overrides
 */
export function loadRailwayConfig(overrides = {}) {
  let fileConfig = {};
  if (existsSync(railwayProjectConfigPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(railwayProjectConfigPath, "utf8"));
    } catch {
      fileConfig = {};
    }
  }

  return {
    projectId:
      overrides.projectId ||
      process.env.RAILWAY_PROJECT_ID?.trim() ||
      fileConfig.projectId ||
      LEGACY_RAILWAY_DEFAULTS.projectId,
    environmentId:
      overrides.environmentId ||
      process.env.RAILWAY_ENVIRONMENT_ID?.trim() ||
      fileConfig.environmentId ||
      LEGACY_RAILWAY_DEFAULTS.environmentId,
    mcpServiceId:
      overrides.mcpServiceId ||
      process.env.RAILWAY_MCP_SERVICE_ID?.trim() ||
      fileConfig.mcpServiceId ||
      LEGACY_RAILWAY_DEFAULTS.mcpServiceId,
    publicUrl:
      overrides.publicUrl ||
      process.env.RAILWAY_URL?.trim() ||
      fileConfig.publicUrl ||
      LEGACY_RAILWAY_DEFAULTS.publicUrl,
    postgresServiceName:
      overrides.postgresServiceName ||
      fileConfig.postgresServiceName ||
      LEGACY_RAILWAY_DEFAULTS.postgresServiceName,
    redisServiceName:
      overrides.redisServiceName ||
      fileConfig.redisServiceName ||
      LEGACY_RAILWAY_DEFAULTS.redisServiceName,
    mcpServiceName:
      overrides.mcpServiceName ||
      fileConfig.mcpServiceName ||
      LEGACY_RAILWAY_DEFAULTS.mcpServiceName,
    volumeMountPath: overrides.volumeMountPath || LEGACY_RAILWAY_DEFAULTS.volumeMountPath,
    dataDir: overrides.dataDir || LEGACY_RAILWAY_DEFAULTS.dataDir,
    postgresImage: overrides.postgresImage || LEGACY_RAILWAY_DEFAULTS.postgresImage,
    redisImage: overrides.redisImage || LEGACY_RAILWAY_DEFAULTS.redisImage,
    githubRepo: overrides.githubRepo || fileConfig.githubRepo || LEGACY_RAILWAY_DEFAULTS.githubRepo,
    projectName: overrides.projectName || fileConfig.projectName,
  };
}

/**
 * @param {typeof LEGACY_RAILWAY_DEFAULTS & { projectName?: string }} config
 */
export function saveRailwayConfig(config) {
  mkdirSync(dirname(railwayProjectConfigPath), { recursive: true });
  const payload = {
    projectId: config.projectId,
    environmentId: config.environmentId,
    mcpServiceId: config.mcpServiceId,
    publicUrl: config.publicUrl,
    postgresServiceName: config.postgresServiceName,
    redisServiceName: config.redisServiceName,
    mcpServiceName: config.mcpServiceName,
    githubRepo: config.githubRepo,
    projectName: config.projectName,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(railwayProjectConfigPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

export function getRailwayToken() {
  return process.env.RAILWAY_TOKEN?.trim() || "";
}

export async function railwayGql(token, query, variables) {
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

export async function listProjects(token) {
  const data = await railwayGql(
    token,
    `query {
      projects { edges { node { id name createdAt } } }
    }`,
  );
  return data.projects.edges.map((edge) => edge.node);
}

export async function getProject(token, projectId) {
  const data = await railwayGql(
    token,
    `query($projectId: String!) {
      project(id: $projectId) {
        id name
        environments { edges { node { id name } } }
        services { edges { node { id name } } }
      }
    }`,
    { projectId },
  );
  return data.project;
}

export async function findServiceByName(token, projectId, name) {
  const project = await getProject(token, projectId);
  return project.services.edges.find((edge) => edge.node.name === name)?.node;
}

export async function getProductionEnvironmentId(project) {
  const production =
    project.environments.edges.find((edge) => edge.node.name === "production")?.node ||
    project.environments.edges[0]?.node;
  if (!production) {
    throw new Error("No environment found in Railway project.");
  }
  return production.id;
}

/**
 * @param {string} token
 * @param {string} environmentId
 * @param {string} serviceId
 * @returns {Promise<string | undefined>}
 */
export async function getServicePublicUrl(token, environmentId, serviceId) {
  const data = await railwayGql(
    token,
    `query($environmentId: String!, $serviceId: String!) {
      serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
        domains { serviceDomains { domain } }
      }
    }`,
    { environmentId, serviceId },
  );
  return data.serviceInstance?.domains?.serviceDomains?.[0]?.domain;
}

export async function getServiceVariables(token, config, serviceId = config.mcpServiceId) {
  const data = await railwayGql(
    token,
    `query($projectId: String!, $environmentId: String!, $serviceId: String!) {
      variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
    }`,
    {
      projectId: config.projectId,
      environmentId: config.environmentId,
      serviceId,
    },
  );
  return data.variables || {};
}

export async function upsertVariable(token, config, name, value, serviceId = config.mcpServiceId) {
  await railwayGql(
    token,
    `mutation($input: VariableUpsertInput!) {
      variableUpsert(input: $input)
    }`,
    {
      input: {
        projectId: config.projectId,
        environmentId: config.environmentId,
        serviceId,
        name,
        value,
        skipDeploys: true,
      },
    },
  );
}

export async function redeployService(token, config, serviceId = config.mcpServiceId) {
  await railwayGql(
    token,
    `mutation($environmentId: String!, $serviceId: String!) {
      serviceInstanceDeployV2(environmentId: $environmentId, serviceId: $serviceId)
    }`,
    {
      environmentId: config.environmentId,
      serviceId,
    },
  );
}

export async function createProjectFromRepo(token, { name, githubRepo, workspaceId }) {
  const input = {
    name,
    defaultEnvironmentName: "production",
    isMonorepo: true,
    repo: { fullRepoName: githubRepo, branch: "main" },
  };
  if (workspaceId) input.workspaceId = workspaceId;

  const data = await railwayGql(
    token,
    `mutation($input: ProjectCreateInput!) {
      projectCreate(input: $input) { id name }
    }`,
    { input },
  );
  return data.projectCreate;
}

export async function createService(token, { projectId, environmentId, name, image }) {
  const input = {
    projectId,
    name,
    environmentId,
    source: { image },
  };
  const data = await railwayGql(
    token,
    `mutation($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id name }
    }`,
    { input },
  );
  return data.serviceCreate;
}

export async function ensureServiceDomain(token, environmentId, serviceId, targetPort = 8080) {
  const existing = await getServicePublicUrl(token, environmentId, serviceId);
  if (existing) return existing;

  const data = await railwayGql(
    token,
    `mutation($input: ServiceDomainCreateInput!) {
      serviceDomainCreate(input: $input) { domain }
    }`,
    {
      input: { environmentId, serviceId, targetPort },
    },
  );
  return data.serviceDomainCreate.domain;
}

export function summarizeCredential(name, value) {
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

const REQUIRED_RAILWAY_KEYS = [
  "MCP_API_KEY",
  "DATABASE_URL",
  "CDP_API_KEY",
  "CDP_PRIVATE_KEY",
  "CDP_WALLET_SECRET",
  "NETWORK",
];

/**
 * @param {Record<string, string>} vars
 * @returns {import("./repo-health-report.mjs").HealthCheck[]}
 */
export function evaluateRailwayEnv(vars) {
  /** @type {import("./repo-health-report.mjs").HealthCheck[]} */
  const checks = [];
  for (const key of REQUIRED_RAILWAY_KEYS) {
    const present = Boolean(vars[key]?.trim());
    checks.push({
      name: `railway_env_${key.toLowerCase()}`,
      level: "warning",
      ok: present,
      detail: present ? "set" : "missing on Railway",
    });
  }
  if (vars.STORAGE_BACKEND && vars.STORAGE_BACKEND !== "postgres") {
    checks.push({
      name: "railway_env_storage_backend",
      level: "warning",
      ok: false,
      detail: `STORAGE_BACKEND=${vars.STORAGE_BACKEND} (expected postgres)`,
    });
  }
  if (!vars.REDIS_URL?.trim()) {
    checks.push({
      name: "railway_env_redis_url",
      level: "warning",
      ok: false,
      detail: "missing on Railway",
    });
  }
  return checks;
}
