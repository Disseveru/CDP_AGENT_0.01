#!/usr/bin/env node
/**
 * Safely sync operational env vars from Cursor Cloud / local shell to Render.
 *
 * Copies only keys that are present in the environment and differ from Render.
 * Uses per-key Render API updates so masked secret placeholders from getEnvVars
 * are never bulk-written as empty strings.
 *
 * Usage:
 *   npm run render:sync-env              # dry-run
 *   npm run render:sync-env -- --apply   # write + optional --redeploy
 */
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import {
  findService,
  getEnvVars,
  getRenderApiKey,
  servicePublicUrl,
  setEnvVar,
  triggerDeploy,
} from "./render-api.mjs";

const DEFAULT_RENDER_URL = "https://cdp-agent-0-01.onrender.com";

/** Keys we may copy from env → Render when set locally. */
export const SYNC_KEYS = [
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

export const ENV_ALIASES = {
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

/**
 * @param {Record<string, string>} renderVars snapshot from getEnvVars (masked secrets may be "")
 * @param {{ resolveEnv: (name: string) => string | undefined, serviceUrl: string }} options
 * @returns {{ key: string, value: string, reason: string }[]}
 */
export function computeRenderSyncUpdates(renderVars, { resolveEnv: resolveEnvFn, serviceUrl }) {
  const vars = { ...renderVars };
  const updates = [];

  for (const key of SYNC_KEYS) {
    const incoming = resolveEnvFn(key);
    if (!incoming) continue;
    if (vars[key] === incoming) continue;
    updates.push({ key, value: incoming, reason: `${key}=updated (${incoming.length} chars)` });
    vars[key] = incoming;
  }

  const operatorEmail = resolveEnvFn("OPERATOR_EMAIL");
  if (!vars.OPERATOR_EMAIL?.trim() && operatorEmail) {
    updates.push({ key: "OPERATOR_EMAIL", value: operatorEmail, reason: "OPERATOR_EMAIL=updated" });
    vars.OPERATOR_EMAIL = operatorEmail;
  }

  if (!vars.SMTP_USER?.trim() && vars.OPERATOR_EMAIL?.trim()) {
    updates.push({
      key: "SMTP_USER",
      value: vars.OPERATOR_EMAIL,
      reason: "SMTP_USER=set from OPERATOR_EMAIL",
    });
  }

  if (!vars.PUBLIC_URL?.trim() && serviceUrl) {
    updates.push({ key: "PUBLIC_URL", value: serviceUrl, reason: `PUBLIC_URL=${serviceUrl}` });
  }

  return updates;
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
  const updates = computeRenderSyncUpdates(vars, { resolveEnv, serviceUrl });

  console.log(`Render env sync → ${service.name} (${serviceUrl})`);
  console.log(args.apply ? "Mode: apply" : "Mode: dry-run (pass --apply to write)");
  console.log("");

  if (!updates.length) {
    console.log("No changes needed — Render already matches the local environment.");
    return;
  }

  for (const update of updates) console.log(`  • ${update.reason}`);

  if (!args.apply) {
    console.log("");
    console.log("Re-run with --apply to write changes to Render.");
    return;
  }

  for (const update of updates) {
    await setEnvVar(service.id, update.key, update.value);
  }
  console.log("");
  console.log(`Render environment variables updated (${updates.length} key(s)).`);

  if (args.redeploy) {
    const deploy = await triggerDeploy(service.id);
    const deployId = deploy.deploy?.id || deploy.id || "(unknown)";
    console.log(`Deploy triggered: ${deployId}`);
  } else {
    console.log("Redeploy for changes to take effect: npm run render:sync-env -- --apply --redeploy");
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
