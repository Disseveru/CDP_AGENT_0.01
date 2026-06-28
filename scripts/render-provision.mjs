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
  putEnvVars,
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

  const vars = await getEnvVars(service.id);
  const changes = [];

  if (!vars.MCP_API_KEY?.trim()) {
    const generated = generateApiKey();
    vars.MCP_API_KEY = generated;
    changes.push("MCP_API_KEY=generated");
  } else {
    changes.push("MCP_API_KEY=already set (kept)");
  }

  if (!vars.PUBLIC_URL?.trim()) {
    vars.PUBLIC_URL = serviceUrl;
    changes.push(`PUBLIC_URL=${serviceUrl}`);
  }

  if (!vars.STORAGE_BACKEND?.trim()) {
    vars.STORAGE_BACKEND = "postgres";
    changes.push("STORAGE_BACKEND=postgres");
  }

  if (!vars.NETWORK?.trim()) {
    vars.NETWORK = "base";
    changes.push("NETWORK=base");
  }

  const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
  if (!vars.FACILITATOR_URL?.trim()) {
    vars.FACILITATOR_URL = CDP_FACILITATOR_URL;
    changes.push(`FACILITATOR_URL=${CDP_FACILITATOR_URL}`);
  }

  if (!vars.SMTP_HOST?.trim()) {
    vars.SMTP_HOST = "smtp.gmail.com";
    changes.push("SMTP_HOST=smtp.gmail.com");
  }

  if (!vars.SMTP_PORT?.trim()) {
    vars.SMTP_PORT = "587";
    changes.push("SMTP_PORT=587");
  }

  console.log("");
  console.log("Planned changes:");
  for (const line of changes) console.log(`  • ${line}`);

  const missing = [];
  if (!vars.DATABASE_URL) missing.push("DATABASE_URL (Neon connection string)");
  if (!vars.CDP_API_KEY) missing.push("CDP_API_KEY");
  if (!vars.CDP_PRIVATE_KEY) missing.push("CDP_PRIVATE_KEY");
  if (!vars.CDP_WALLET_SECRET) missing.push("CDP_WALLET_SECRET");
  if (!vars.SMTP_USER || !vars.SMTP_PASS) {
    missing.push("SMTP_USER + SMTP_PASS (Gmail app password)");
  }
  if (!vars.OPERATOR_EMAIL) missing.push("OPERATOR_EMAIL");

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

  await putEnvVars(service.id, vars);
  console.log("");
  console.log("Render environment variables updated.");

  saveSecrets({
    ...loadSecrets(),
    publicUrl: serviceUrl,
    renderUrl: serviceUrl,
    mcpApiKey: vars.MCP_API_KEY,
    renderServiceId: service.id,
    updatedAt: new Date().toISOString(),
  });
  console.log(`Local secrets saved to ${secretsPath}`);

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

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
