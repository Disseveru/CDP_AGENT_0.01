#!/usr/bin/env node
/**
 * Diagnose AgentWire on Render: health, MCP auth, env var presence, boot hints.
 *
 * Usage:
 *   npm run render:diagnose
 *   RENDER_API_KEY=... npm run render:diagnose -- https://cdp-agent-0-01.onrender.com
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findService,
  getEnvVars,
  getRenderApiKey,
  listServices,
  servicePublicUrl,
} from "./render-api.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const secretsPath = join(repoRoot, ".cursor", "mcp-setup.secrets.json");

const DEFAULT_RENDER_URL = "https://cdp-agent-0-01.onrender.com";

function loadLocalConfig() {
  if (existsSync(secretsPath)) {
    const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
    const url =
      secrets.publicUrl?.replace(/\/$/, "") ||
      secrets.renderUrl?.replace(/\/$/, "") ||
      secrets.railwayUrl?.replace(/\/$/, "");
    if (url) return { publicUrl: url, mcpApiKey: secrets.mcpApiKey };
  }
  const envUrl = process.env.RENDER_URL || process.env.PUBLIC_URL;
  if (envUrl) return { publicUrl: envUrl.replace(/\/$/, ""), mcpApiKey: process.env.MCP_API_KEY };
  return { publicUrl: DEFAULT_RENDER_URL, mcpApiKey: undefined };
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
  return `${name}: ${issues.length ? issues.join(", ") : "set (format ok)"}`;
}

async function main() {
  const argvUrl = process.argv[2]?.replace(/\/$/, "");
  const { publicUrl: localUrl, mcpApiKey: localKey } = loadLocalConfig();
  const publicUrl = argvUrl || localUrl;

  console.log("AgentWire Render diagnose");
  console.log(`URL: ${publicUrl}`);
  console.log("");

  try {
    const healthRes = await fetch(`${publicUrl}/health`, { signal: AbortSignal.timeout(120_000) });
    const health = await healthRes.json();
    console.log(`health: ${healthRes.status} status=${health.status} runtime=${health.runtimeStatus}`);
    if (health.storage) {
      console.log(`storage: backend=${health.storage.backend} ok=${health.storage.ok}`);
    }
    if (health.redis) {
      console.log(`redis: ok=${health.redis.ok}${health.redis.detail ? ` (${health.redis.detail})` : ""}`);
    }
    if (health.error) console.log(`health error: ${health.error}`);
  } catch (error) {
    console.log(`health: FAIL (${error.message || error})`);
    console.log("  → Free tier cold start can take 30–90s. Retry in a minute.");
  }

  try {
    const readyRes = await fetch(`${publicUrl}/ready`, { signal: AbortSignal.timeout(120_000) });
    const ready = await readyRes.json();
    console.log(
      `ready:  ${readyRes.status} status=${ready.status} payments=${ready.paymentsAvailable ?? "?"}`,
    );
    if (ready.error) console.log(`ready error: ${ready.error}`);
  } catch (error) {
    console.log(`ready: FAIL (${error.message || error})`);
  }

  const sseNoAuth = await fetch(`${publicUrl}/sse`, { signal: AbortSignal.timeout(30_000) }).catch(
    () => null,
  );
  if (sseNoAuth) {
    console.log(`sse (no key): ${sseNoAuth.status}`);
    if (sseNoAuth.status === 200) {
      console.log("  → WARNING: MCP is open without auth. Set MCP_API_KEY and redeploy.");
    }
  }

  const key = localKey || process.env.MCP_API_KEY;
  if (key) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const sseAuth = await fetch(`${publicUrl}/sse`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    }).catch(() => null);
    clearTimeout(timeout);
    if (sseAuth) {
      console.log(`sse (key):  ${sseAuth.status} ${sseAuth.headers.get("content-type") || ""}`);
      await sseAuth.body?.cancel();
    }
  } else {
    console.log("sse (key):  skipped (no local MCP API key)");
  }

  const discovery = await fetch(`${publicUrl}/`, { signal: AbortSignal.timeout(30_000) }).catch(
    () => null,
  );
  if (discovery) {
    console.log(`discovery GET /: ${discovery.status} (402 is normal on Base mainnet)`);
  }

  const apiKey = getRenderApiKey();
  if (!apiKey) {
    console.log("");
    console.log("Set RENDER_API_KEY to also fetch Render variables (names only, values hidden).");
    return;
  }

  console.log("");
  console.log("Render services:");
  const services = await listServices();
  for (const service of services) {
    const url = servicePublicUrl(service);
    console.log(`  - ${service.name} (${service.id}) ${url || ""}`);
  }

  let service = await findService({ url: publicUrl });
  if (!service) {
    service = await findService({ name: "agentwire" });
  }
  if (!service) {
    console.log("");
    console.log(`Could not match Render service for ${publicUrl}. Pass the exact URL or rename service to agentwire.`);
    return;
  }

  console.log("");
  console.log(`Matched service: ${service.name} (${service.id})`);
  const vars = await getEnvVars(service.id);

  console.log("");
  console.log("Render variables (format only, values hidden):");
  for (const key of ["NETWORK", "STORAGE_BACKEND", "FACILITATOR_URL", "PUBLIC_URL", "MCP_API_KEY"]) {
    if (key === "MCP_API_KEY") {
      console.log(`MCP_API_KEY: ${vars.MCP_API_KEY ? "set" : "MISSING (required on Render)"}`);
      continue;
    }
    console.log(`${key}: ${vars[key] || "(unset)"}`);
  }
  for (const key of ["DATABASE_URL", "REDIS_URL"]) {
    console.log(`${key}: ${vars[key] ? "set" : "missing"}`);
  }
  for (const key of ["CDP_API_KEY", "CDP_PRIVATE_KEY", "CDP_WALLET_SECRET"]) {
    console.log(summarizeCredential(key, vars[key]));
  }

  console.log("");
  console.log("Gmail / operator notifications:");
  for (const key of [
    "OPERATOR_EMAIL",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASS",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM_NUMBER",
  ]) {
    if (/PASS|TOKEN|SID|DATABASE|REDIS/i.test(key)) {
      console.log(`${key}: ${vars[key] ? "set" : "missing"}`);
      continue;
    }
    console.log(`${key}: ${vars[key] || "(unset)"}`);
  }

  const smtpPartial =
    (vars.SMTP_USER && !vars.SMTP_PASS) || (!vars.SMTP_USER && vars.SMTP_PASS);
  const twilioKeys = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"];
  const twilioPartial = twilioKeys.filter((key) => Boolean(vars[key]));
  if (smtpPartial) {
    console.log("  → SMTP partially configured; set both SMTP_USER and SMTP_PASS or remove both.");
  }
  if (twilioPartial.length > 0 && twilioPartial.length < 3) {
    console.log("  → Twilio partially configured; set all three TWILIO_* vars or remove all.");
  }
  if (!vars.TWILIO_ACCOUNT_SID) {
    console.log("  → Twilio correctly absent (Gmail-only mode).");
  }
  if (!vars.STORAGE_BACKEND || vars.STORAGE_BACKEND !== "postgres") {
    console.log("  → Set STORAGE_BACKEND=postgres for Neon.");
  }
  if (!vars.DATABASE_URL) {
    console.log("  → DATABASE_URL missing — inboxes will not survive redeploys.");
  }
  if (!vars.MCP_API_KEY) {
    console.log("  → MCP_API_KEY missing — run: RENDER_API_KEY=... npm run render:provision");
  }
  if (!vars.REDIS_URL) {
    console.log("  → REDIS_URL unset — CAPTCHA tools disabled (optional).");
  }

  const tsxPath = join(repoRoot, "gas-oracle-mcp", "node_modules", ".bin", "tsx");
  if (existsSync(tsxPath) && vars.CDP_API_KEY && vars.CDP_PRIVATE_KEY) {
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
      console.log("");
      console.log(`CDP facilitator credential check: ${issue}`);
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
