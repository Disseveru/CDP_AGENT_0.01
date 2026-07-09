#!/usr/bin/env node
/**
 * Safely sync operational env vars from Cursor Cloud / local shell to Render.
 *
 * Copies only keys that are present in the environment and differ from Render.
 * Values are never printed.
 *
 * Usage:
 *   npm run render:sync-env              # dry-run
 *   npm run render:sync-env -- --apply   # write + optional --redeploy
 */
import { parseArgs } from "node:util";

import {
  findService,
  getEnvVars,
  getRenderApiKey,
  putEnvVars,
  servicePublicUrl,
  triggerDeploy,
} from "./render-api.mjs";

const DEFAULT_RENDER_URL = "https://cdp-agent-0-01.onrender.com";

/** Keys we may copy from env → Render when set locally. */
const SYNC_KEYS = [
  "CDP_API_KEY",
  "CDP_PRIVATE_KEY",
  "CDP_WALLET_SECRET",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "OPERATOR_SMS_NUMBER",
  "OPERATOR_EMAIL",
  "SMTP_USER",
  "SMTP_PASS",
  "NTFY_TOPIC",
];

const ENV_ALIASES = {
  CDP_API_KEY: ["CDP_API_KEY", "CDP_API_KEY_ID"],
  CDP_PRIVATE_KEY: ["CDP_PRIVATE_KEY", "CDP_API_KEY_SECRET"],
  SMTP_PASS: ["SMTP_PASS", "SMTH_PASS"],
  SMTP_USER: ["SMTP_USER", "OPERATOR_EMAIL"],
};

const { values: args } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    redeploy: { type: "boolean", default: false },
  },
});

function resolveEnv(name) {
  const keys = ENV_ALIASES[name] ?? [name];
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

async function main() {
  if (!getRenderApiKey()) {
    throw new Error("RENDER_API_KEY is unset.");
  }

  const targetUrl = (
    process.env.RENDER_URL ||
    process.env.PUBLIC_URL ||
    DEFAULT_RENDER_URL
  ).replace(/\/$/, "");

  let service = await findService({ url: targetUrl });
  if (!service) service = await findService({ name: "CDP_AGENT_0.01" });
  if (!service) service = await findService({ name: "agentwire" });
  if (!service) {
    throw new Error(`No Render service matched ${targetUrl}`);
  }

  const serviceUrl = servicePublicUrl(service) || targetUrl;
  const vars = await getEnvVars(service.id);
  const changes = [];

  for (const key of SYNC_KEYS) {
    const incoming = resolveEnv(key);
    if (!incoming) continue;
    if (vars[key] === incoming) continue;
    vars[key] = incoming;
    changes.push(`${key}=updated (${incoming.length} chars)`);
  }

  if (!vars.OPERATOR_EMAIL?.trim() && resolveEnv("OPERATOR_EMAIL")) {
    vars.OPERATOR_EMAIL = resolveEnv("OPERATOR_EMAIL");
    changes.push("OPERATOR_EMAIL=updated");
  }

  if (!vars.SMTP_USER?.trim() && vars.OPERATOR_EMAIL?.trim()) {
    vars.SMTP_USER = vars.OPERATOR_EMAIL;
    changes.push("SMTP_USER=set from OPERATOR_EMAIL");
  }

  if (!vars.PUBLIC_URL?.trim()) {
    vars.PUBLIC_URL = serviceUrl;
    changes.push(`PUBLIC_URL=${serviceUrl}`);
  }

  console.log(`Render env sync → ${service.name} (${serviceUrl})`);
  console.log(args.apply ? "Mode: apply" : "Mode: dry-run (pass --apply to write)");
  console.log("");

  if (!changes.length) {
    console.log("No changes needed — Render already matches the local environment.");
    return;
  }

  for (const line of changes) console.log(`  • ${line}`);

  if (!args.apply) {
    console.log("");
    console.log("Re-run with --apply to write changes to Render.");
    return;
  }

  await putEnvVars(service.id, vars);
  console.log("");
  console.log("Render environment variables updated.");

  if (args.redeploy) {
    const deploy = await triggerDeploy(service.id);
    const deployId = deploy.deploy?.id || deploy.id || "(unknown)";
    console.log(`Deploy triggered: ${deployId}`);
  } else {
    console.log("Redeploy for changes to take effect: npm run render:sync-env -- --apply --redeploy");
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
