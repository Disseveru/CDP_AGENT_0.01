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

import {
  getRailwayToken,
  loadRailwayConfig,
  railwayGql,
  summarizeCredential,
} from "./railway-api.mjs";

const config = loadRailwayConfig();

function loadLocalConfig() {
  if (existsSync(secretsPath)) {
    const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
    return {
      railwayUrl: secrets.railwayUrl || secrets.publicUrl,
      mcpApiKey: secrets.mcpApiKey,
    };
  }
  if (process.env.RAILWAY_URL) {
    return { railwayUrl: process.env.RAILWAY_URL.replace(/\/$/, "") };
  }
  return { railwayUrl: config.publicUrl.replace(/\/$/, "") };
}

async function gql(token, query, variables) {
  return railwayGql(token, query, variables);
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

  const token = getRailwayToken();
  if (!token) {
    console.log("");
    console.log("Set RAILWAY_TOKEN to also fetch Railway variables and boot logs.");
    return;
  }

  try {
    const stagedData = await gql(
      token,
      `query($environmentId: String!) {
        environmentStagedChanges(environmentId: $environmentId) {
          id status message lastAppliedError appliedAt patch
        }
      }`,
      { environmentId: config.environmentId },
    );
    const staged = stagedData.environmentStagedChanges;
    if (staged?.id) {
      console.log("");
      console.log(`Railway staged changes: status=${staged.status} id=${staged.id}`);
      if (staged.status === "APPLYING") {
        console.log(
          "  → Stuck APPLYING patch in Railway UI. Discard in dashboard (Inspect → X) or run:",
        );
        console.log("    npm run railway:staged-fix");
      }
      if (staged.lastAppliedError) {
        console.log(`  → lastAppliedError: ${staged.lastAppliedError}`);
      }
      if (staged.patch?.volumes || staged.patch?.services?.[config.mcpServiceId]?.volumeMounts) {
        console.log("  → patch touches volumes/volumeMounts (duplicate mount can wedge APPLYING).");
      }
    }
  } catch (error) {
    console.log("");
    console.log(`Railway staged changes: unavailable (${error.message})`);
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
    { projectId: config.projectId, environmentId: config.environmentId, serviceId: config.mcpServiceId },
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

  console.log("");
  console.log("CAPTCHA operator notifications:");
  for (const key of [
    "OPERATOR_SMS_NUMBER",
    "OPERATOR_EMAIL",
    "PUBLIC_URL",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM_NUMBER",
    "SMTP_USER",
    "SMTP_PASS",
    "NTFY_TOPIC",
    "NTFY_SERVER",
    "NTFY_TOKEN",
  ]) {
    if (/PASS|TOKEN|SID/i.test(key)) {
      console.log(`${key}: ${vars[key] ? "set" : "missing"}`);
      continue;
    }
    console.log(`${key}: ${vars[key] || "(unset)"}`);
  }

  const smtpPartial =
    (vars.SMTP_USER && !vars.SMTP_PASS) || (!vars.SMTP_USER && vars.SMTP_PASS);
  const twilioPartial = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"].filter(
    (key) => Boolean(vars[key]),
  );
  if (smtpPartial) {
    console.log("  → SMTP is partially configured; set both SMTP_USER and SMTP_PASS or remove both.");
  }
  if (twilioPartial.length > 0 && twilioPartial.length < 3) {
    console.log("  → Twilio is partially configured; set all three TWILIO_* vars or remove all.");
  }
  if (!vars.TWILIO_ACCOUNT_SID) {
    console.log("  → Twilio SMS optional — toll-free verification can take days.");
  }
  if (!vars.SMTP_PASS && !vars.NTFY_TOPIC) {
    console.log("  → For instant alerts without Twilio, set SMTP_PASS (Gmail) or NTFY_TOPIC (ntfy app).");
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
