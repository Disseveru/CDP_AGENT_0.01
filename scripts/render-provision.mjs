#!/usr/bin/env node
/**
 * Provision AgentWire on Render: ensure MCP_API_KEY, PUBLIC_URL, and trigger redeploy.
 *
 * Usage:
 *   RENDER_API_KEY=... npm run render:provision
 *   RENDER_API_KEY=... npm run render:provision -- --redeploy
 *   RENDER_API_KEY=... npm run render:provision -- https://cdp-agent-0-01.onrender.com
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import {
  findService,
  getEnvVars,
  getRenderApiKey,
  setEnvVar,
  servicePublicUrl,
  triggerDeploy,
} from "./render-api.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const secretsPath = join(repoRoot, ".cursor", "mcp-setup.secrets.json");

const DEFAULT_RENDER_URL = "https://cdp-agent-0-01.onrender.com";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    redeploy: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    name: { type: "string" },
  },
});

function generateApiKey() {
  return randomBytes(32).toString("base64url");
}

function normalizeUrl(input) {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Invalid URL "${input}". Use https://your-service.onrender.com`);
  }
  return trimmed;
}

function loadSecrets() {
  if (!existsSync(secretsPath)) return {};
  return JSON.parse(readFileSync(secretsPath, "utf8"));
}

function saveSecrets(data) {
  mkdirSync(dirname(secretsPath), { recursive: true });
  writeFileSync(secretsPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

/**
 * Keys written by render-provision. Per-key updates avoid bulk env-var replacement,
 * which would overwrite masked Render secrets (DATABASE_URL, CDP_API_KEY, etc.) with "".
 *
 * @param {Record<string, string>} renderVars snapshot from getEnvVars
 * @param {string} serviceUrl
 * @param {{ generateApiKey: () => string }} options
 * @returns {{ updates: { key: string, value: string }[], changes: string[], mcpApiKey: string | undefined }}
 */
export function computeRenderProvisionUpdates(renderVars, serviceUrl, { generateApiKey }) {
  const updates = [];
  const changes = [];
  let mcpApiKey;

  const renderHasMcpKey = Object.prototype.hasOwnProperty.call(renderVars, "MCP_API_KEY");
  if (!renderHasMcpKey) {
    mcpApiKey = generateApiKey();
    updates.push({ key: "MCP_API_KEY", value: mcpApiKey });
    changes.push("MCP_API_KEY=generated");
  } else if (!renderVars.MCP_API_KEY?.trim()) {
    changes.push("MCP_API_KEY=already set (kept)");
  } else {
    mcpApiKey = renderVars.MCP_API_KEY;
    changes.push("MCP_API_KEY=already set (kept)");
  }

  if (!renderVars.PUBLIC_URL?.trim()) {
    updates.push({ key: "PUBLIC_URL", value: serviceUrl });
    changes.push(`PUBLIC_URL=${serviceUrl}`);
  }

  if (!renderVars.STORAGE_BACKEND?.trim()) {
    updates.push({ key: "STORAGE_BACKEND", value: "postgres" });
    changes.push("STORAGE_BACKEND=postgres");
  }

  if (!renderVars.NETWORK?.trim()) {
    updates.push({ key: "NETWORK", value: "base" });
    changes.push("NETWORK=base");
  }

  if (!renderVars.FACILITATOR_URL?.trim()) {
    updates.push({ key: "FACILITATOR_URL", value: CDP_FACILITATOR_URL });
    changes.push(`FACILITATOR_URL=${CDP_FACILITATOR_URL}`);
  }

  if (!renderVars.SMTP_HOST?.trim()) {
    updates.push({ key: "SMTP_HOST", value: "smtp.gmail.com" });
    changes.push("SMTP_HOST=smtp.gmail.com");
  }

  if (!renderVars.SMTP_PORT?.trim()) {
    updates.push({ key: "SMTP_PORT", value: "587" });
    changes.push("SMTP_PORT=587");
  }

  return { updates, changes, mcpApiKey };
}

async function main() {
  if (!getRenderApiKey()) {
    throw new Error(
      "RENDER_API_KEY is unset. Add it in Cursor Cloud secrets or export it locally.",
    );
  }

  const targetUrl = normalizeUrl(
    positionals[0] ||
      process.env.RENDER_URL ||
      process.env.PUBLIC_URL ||
      loadSecrets().publicUrl ||
      loadSecrets().renderUrl ||
      DEFAULT_RENDER_URL,
  );

  console.log("AgentWire Render provision");
  console.log(`Target URL: ${targetUrl}`);
  console.log("");

  let service = await findService({ url: targetUrl });
  if (!service && args.name) {
    service = await findService({ name: args.name });
  }
  if (!service) {
    service = await findService({ name: "agentwire" });
  }
  if (!service) {
    service = await findService({ name: "cdp-agent-0-01" });
  }
  if (!service) {
    throw new Error(
      `No Render service matched ${targetUrl}. Create the web service first (docs/RENDER-DEPLOY.md).`,
    );
  }

  const serviceUrl = servicePublicUrl(service) || targetUrl;
  console.log(`Service: ${service.name} (${service.id})`);
  console.log(`Render URL: ${serviceUrl}`);

  const renderVars = await getEnvVars(service.id);
  const { updates, changes, mcpApiKey } = computeRenderProvisionUpdates(renderVars, serviceUrl, {
    generateApiKey,
  });

  console.log("");
  console.log("Planned changes:");
  for (const line of changes) console.log(`  • ${line}`);

  const missing = [];
  const needsKey = (key, label) => {
    if (renderVars[key]?.trim()) return;
    if (Object.prototype.hasOwnProperty.call(renderVars, key)) return;
    missing.push(label);
  };

  needsKey("DATABASE_URL", "DATABASE_URL (Neon connection string)");
  needsKey("CDP_API_KEY", "CDP_API_KEY");
  needsKey("CDP_PRIVATE_KEY", "CDP_PRIVATE_KEY");
  needsKey("CDP_WALLET_SECRET", "CDP_WALLET_SECRET");
  if (!renderVars.SMTP_USER?.trim() && !Object.prototype.hasOwnProperty.call(renderVars, "SMTP_USER")) {
    missing.push("SMTP_USER + SMTP_PASS (Gmail app password)");
  } else if (!renderVars.SMTP_PASS?.trim() && !Object.prototype.hasOwnProperty.call(renderVars, "SMTP_PASS")) {
    missing.push("SMTP_PASS (Gmail app password)");
  }
  needsKey("OPERATOR_EMAIL", "OPERATOR_EMAIL");

  if (missing.length) {
    console.log("");
    console.log("Still missing in Render (add manually in dashboard):");
    for (const item of missing) console.log(`  • ${item}`);
  }

  if (args["dry-run"]) {
    console.log("");
    console.log("Dry run — no Render changes written.");
    return;
  }

  for (const update of updates) {
    await setEnvVar(service.id, update.key, update.value);
  }
  console.log("");
  console.log(`Render environment variables updated (${updates.length} key(s)).`);

  const resolvedMcpApiKey = mcpApiKey || renderVars.MCP_API_KEY;
  if (resolvedMcpApiKey) {
    saveSecrets({
      ...loadSecrets(),
      publicUrl: serviceUrl,
      renderUrl: serviceUrl,
      mcpApiKey: resolvedMcpApiKey,
      renderServiceId: service.id,
      updatedAt: new Date().toISOString(),
    });
    console.log(`Local secrets saved to ${secretsPath}`);
  }

  if (args.redeploy) {
    const deploy = await triggerDeploy(service.id);
    const deployId = deploy.deploy?.id || deploy.id || "(unknown)";
    console.log(`Deploy triggered: ${deployId}`);
    console.log("Watch progress in Render → Logs.");
  } else {
    console.log("");
    console.log("Redeploy required for env changes to take effect:");
    console.log("  RENDER_API_KEY=... npm run render:provision -- --redeploy");
    console.log("Or tap Manual Deploy in the Render dashboard.");
  }

  console.log("");
  console.log("Cursor MCP setup (when you use a computer):");
  console.log(`  npm run setup:cursor-mcp -- ${serviceUrl}`);
  console.log("  npm run verify:cursor-mcp");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
