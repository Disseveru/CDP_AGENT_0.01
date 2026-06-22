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

const RAILWAY_GRAPHQL = "https://backboard.railway.com/graphql/v2";

const DEFAULTS = {
  projectId: "2d961fd8-a0a9-4ae6-93e1-3e209858e7f2",
  environmentId: "5a065ed8-6c1b-4aa6-8968-7f5f3804c868",
  mcpServiceId: "0baa1261-4e18-4216-9377-e24e77655561",
  publicUrl: "https://gas-oracle-mcp-production.up.railway.app",
  operatorSmsNumber: "+17472241814",
  operatorEmail: "er2k18@gmail.com",
};

const { values: args } = parseArgs({
  options: {
    redeploy: { type: "boolean", default: false },
  },
});

/** Static config written on every provision run. */
const STATIC_VARIABLES = [
  ["PUBLIC_URL", DEFAULTS.publicUrl],
  ["OPERATOR_SMS_NUMBER", DEFAULTS.operatorSmsNumber],
  ["OPERATOR_EMAIL", DEFAULTS.operatorEmail],
  ["SMTP_HOST", "smtp.gmail.com"],
  ["SMTP_PORT", "587"],
  ["SMTP_USER", DEFAULTS.operatorEmail],
  ["PRICE_CAPTCHA_SUBMIT", "$0.050"],
  ["PRICE_CAPTCHA_BYPASS", "$0.075"],
  ["CAPTCHA_TASK_TTL_SEC", "3600"],
  ["CAPTCHA_POLL_TIMEOUT_MS", "300000"],
  ["CAPTCHA_POLL_INTERVAL_MS", "2000"],
];

/** Secrets pulled from the provisioner's environment when present. */
const SECRET_ENV_MAP = [
  ["TWILIO_ACCOUNT_SID", "TWILIO_ACCOUNT_SID"],
  ["TWILIO_AUTH_TOKEN", "TWILIO_AUTH_TOKEN"],
  ["TWILIO_FROM_NUMBER", "TWILIO_FROM_NUMBER"],
  ["SMTP_PASS", "SMTP_PASS"],
];

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

async function upsertVariable(token, name, value) {
  await gql(
    token,
    `mutation($input: VariableUpsertInput!) {
      variableUpsert(input: $input)
    }`,
    {
      input: {
        projectId: DEFAULTS.projectId,
        environmentId: DEFAULTS.environmentId,
        serviceId: DEFAULTS.mcpServiceId,
        name,
        value,
        skipDeploys: true,
      },
    },
  );
  console.log(`Set ${name}`);
}

async function redeployMcp(token) {
  await gql(
    token,
    `mutation($environmentId: String!, $serviceId: String!) {
      serviceInstanceDeployV2(environmentId: $environmentId, serviceId: $serviceId)
    }`,
    {
      environmentId: DEFAULTS.environmentId,
      serviceId: DEFAULTS.mcpServiceId,
    },
  );
  console.log("Triggered MCP redeploy.");
}

async function main() {
  const token = process.env.RAILWAY_TOKEN?.trim();
  if (!token) {
    throw new Error("RAILWAY_TOKEN is required.");
  }

  console.log("AgentWire notification variable provision");
  console.log(`Service:  gas-oracle-mcp (${DEFAULTS.mcpServiceId})`);
  console.log(`Operator: ${DEFAULTS.operatorEmail} / ${DEFAULTS.operatorSmsNumber}`);
  console.log("");

  for (const [name, value] of STATIC_VARIABLES) {
    await upsertVariable(token, name, value);
  }

  const missingSecrets = [];
  for (const [railwayName, envName] of SECRET_ENV_MAP) {
    const value = process.env[envName]?.trim();
    if (value) {
      await upsertVariable(token, railwayName, value);
    } else {
      missingSecrets.push(railwayName);
    }
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
