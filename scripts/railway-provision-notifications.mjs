#!/usr/bin/env node
/**
 * Provision CAPTCHA operator notification variables on Railway gas-oracle-mcp.
 *
 * Non-secret defaults are applied automatically. Secrets are read from the
 * caller's environment (set in Cursor Cloud Agent secrets or export locally):
 *
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   SMTP_PASS  (Gmail app password)
 *
 * Usage:
 *   RAILWAY_TOKEN=... npm run railway:provision-notifications
 *   RAILWAY_TOKEN=... npm run railway:provision-notifications -- --redeploy
 */
import { parseArgs } from "node:util";

import {
  getRailwayToken,
  loadRailwayConfig,
  redeployService,
  upsertVariable,
} from "./railway-api.mjs";

const config = loadRailwayConfig();
const operatorSmsNumber = process.env.OPERATOR_SMS_NUMBER?.trim();
const operatorEmail = process.env.OPERATOR_EMAIL?.trim();

const { values: args } = parseArgs({
  options: {
    redeploy: { type: "boolean", default: false },
  },
});

/** Static config written on every provision run. */
const STATIC_VARIABLES = [
  ["PUBLIC_URL", config.publicUrl],
  ["PRICE_CAPTCHA_SUBMIT", "$0.050"],
  ["PRICE_CAPTCHA_BYPASS", "$0.075"],
  ["CAPTCHA_TASK_TTL_SEC", "3600"],
  ["CAPTCHA_POLL_TIMEOUT_MS", "300000"],
  ["CAPTCHA_POLL_INTERVAL_MS", "2000"],
];

if (operatorSmsNumber) {
  STATIC_VARIABLES.push(["OPERATOR_SMS_NUMBER", normalizeE164(operatorSmsNumber)]);
}
if (operatorEmail) {
  STATIC_VARIABLES.push(["OPERATOR_EMAIL", operatorEmail]);
}

/** Applied only when SMTP_PASS is present — avoids partial SMTP config that fails boot validation. */
const SMTP_VARIABLES = operatorEmail
  ? [
      ["SMTP_HOST", "smtp.gmail.com"],
      ["SMTP_PORT", "587"],
      ["SMTP_USER", operatorEmail],
    ]
  : [
      ["SMTP_HOST", "smtp.gmail.com"],
      ["SMTP_PORT", "587"],
    ];

/** Secrets pulled from the provisioner's environment when present. */
const SECRET_ENV_MAP = [
  ["TWILIO_ACCOUNT_SID", "TWILIO_ACCOUNT_SID"],
  ["TWILIO_AUTH_TOKEN", "TWILIO_AUTH_TOKEN"],
  ["TWILIO_FROM_NUMBER", "TWILIO_FROM_NUMBER"],
  ["OPERATOR_SMS_NUMBER", "OPERATOR_SMS_NUMBER"],
  ["OPERATOR_EMAIL", "OPERATOR_EMAIL"],
  ["SMTP_PASS", "SMTP_PASS"],
  ["NTFY_TOPIC", "NTFY_TOPIC"],
  ["NTFY_SERVER", "NTFY_SERVER"],
  ["NTFY_TOKEN", "NTFY_TOKEN"],
];

async function upsertNotificationVariable(token, name, value) {
  await upsertVariable(token, config, name, value);
  console.log(`Set ${name}`);
}

async function redeployMcp(token) {
  await redeployService(token, config);
  console.log("Triggered MCP redeploy.");
}

function normalizeE164(value) {
  const trimmed = value?.trim();
  if (!trimmed) return trimmed;
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return trimmed;
  if (digits.length === 10) {
    digits = `1${digits}`;
  }
  return `+${digits}`;
}

async function main() {
  const token = getRailwayToken();
  if (!token) {
    throw new Error("RAILWAY_TOKEN is required.");
  }

  console.log("AgentWire notification variable provision");
  console.log(`Service:  ${config.mcpServiceName} (${config.mcpServiceId})`);
  console.log(`Operator: ${operatorEmail} / ${operatorSmsNumber}`);
  console.log("");

  for (const [name, value] of STATIC_VARIABLES) {
    await upsertNotificationVariable(token, name, value);
  }

  const smtpPass = process.env.SMTP_PASS?.trim();
  if (smtpPass) {
    for (const [name, value] of SMTP_VARIABLES) {
      await upsertNotificationVariable(token, name, value);
    }
    await upsertNotificationVariable(token, "SMTP_PASS", smtpPass);
  }

  const missingSecrets = [];
  for (const [railwayName, envName] of SECRET_ENV_MAP) {
    if (railwayName === "SMTP_PASS") continue;
    const value = process.env[envName]?.trim();
    if (value) {
      const normalized =
        railwayName === "TWILIO_FROM_NUMBER" || railwayName === "OPERATOR_SMS_NUMBER"
          ? normalizeE164(value)
          : value;
      await upsertNotificationVariable(token, railwayName, normalized);
    } else {
      missingSecrets.push(railwayName);
    }
  }
  if (!smtpPass) {
    missingSecrets.push("SMTP_PASS");
  }

  if (missingSecrets.length) {
    console.log("");
    console.log("Skipped (not in local env — add in Railway dashboard or re-run with env set):");
    for (const name of missingSecrets) {
      console.log(`  - ${name}`);
    }
  }

  if (args.redeploy) {
    await redeployMcp(token);
  } else {
    console.log("");
    console.log("Variables updated with skipDeploys=true. Redeploy to apply:");
    console.log("  npm run railway:provision-notifications -- --redeploy");
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
