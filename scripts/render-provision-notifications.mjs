#!/usr/bin/env node
/**
 * Provision Gmail-only CAPTCHA operator notifications on Render (no Twilio).
 *
 * Reads secrets from the caller environment when set (Cursor Cloud secrets):
 *   SMTP_PASS, OPERATOR_EMAIL, REDIS_URL
 *
 * If REDIS_URL is unset, provisions a temporary free Upstash Redis via
 * https://upstash.com/start-redis (3-day trial — user should claim in console).
 *
 * Usage:
 *   RENDER_API_KEY=... SMTP_PASS=... npm run render:provision-notifications
 *   RENDER_API_KEY=... npm run render:provision-notifications -- --redeploy
 *   RENDER_API_KEY=... npm run render:provision-notifications -- https://cdp-agent-0-01.onrender.com --redeploy
 */
import { randomUUID } from "node:crypto";
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
const UPSTASH_IDEMPOTENCY_KEY = "b436c100-f33c-419d-aceb-f197e55bbfbf";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    redeploy: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "skip-redis": { type: "boolean", default: false },
  },
});

function normalizeUrl(input) {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Invalid URL "${input}". Use https://your-service.onrender.com`);
  }
  return trimmed;
}

function parseUpstashRedisUrl(markdown) {
  const endpointMatch = /^\*\*Endpoint:\*\* (https:\/\/\S+)/m.exec(markdown);
  const tokenMatch = /^\*\*Token:\*\* (\S+)/m.exec(markdown);
  if (!endpointMatch || !tokenMatch) {
    throw new Error("Could not parse Upstash start-redis response");
  }
  const host = new URL(endpointMatch[1]).hostname;
  const token = tokenMatch[1];
  return `rediss://default:${token}@${host}:6379`;
}

function parseUpstashConsoleUrl(markdown) {
  const match = /(https:\/\/upstash\.com\/start-redis\/console\/[a-f0-9-]+)/.exec(markdown);
  return match?.[1] ?? null;
}

async function ensureUpstashRedis() {
  const response = await fetch("https://upstash.com/start-redis", {
    method: "POST",
    headers: { "Idempotency-Key": UPSTASH_IDEMPOTENCY_KEY },
  });
  const markdown = await response.text();
  if (!response.ok) {
    throw new Error(`Upstash start-redis failed (${response.status}): ${markdown.slice(0, 200)}`);
  }
  return {
    redisUrl: parseUpstashRedisUrl(markdown),
    consoleUrl: parseUpstashConsoleUrl(markdown),
  };
}

async function main() {
  if (!getRenderApiKey()) {
    throw new Error("RENDER_API_KEY is unset.");
  }

  const targetUrl = normalizeUrl(
    positionals.find((value) => value.startsWith("http")) ||
      process.env.RENDER_URL ||
      process.env.PUBLIC_URL ||
      DEFAULT_RENDER_URL,
  );

  console.log("AgentWire Render notification provision (Gmail-only, no Twilio)");
  console.log(`Target URL: ${targetUrl}`);
  console.log("");

  let service = await findService({ url: targetUrl });
  if (!service) service = await findService({ name: "CDP_AGENT_0.01" });
  if (!service) service = await findService({ name: "agentwire" });
  if (!service) {
    throw new Error(`No Render service matched ${targetUrl}`);
  }

  const serviceUrl = servicePublicUrl(service) || targetUrl;
  console.log(`Service: ${service.name} (${service.id})`);

  const vars = await getEnvVars(service.id);
  const changes = [];

  const operatorEmail =
    process.env.OPERATOR_EMAIL?.trim() || vars.OPERATOR_EMAIL?.trim() || "er2k18@gmail.com";
  if (vars.OPERATOR_EMAIL !== operatorEmail) {
    vars.OPERATOR_EMAIL = operatorEmail;
    changes.push(`OPERATOR_EMAIL=${operatorEmail}`);
  }

  const smtpDefaults = {
    SMTP_HOST: "smtp.gmail.com",
    SMTP_PORT: "587",
    SMTP_USER: operatorEmail,
  };
  for (const [key, value] of Object.entries(smtpDefaults)) {
    if (!vars[key]?.trim()) {
      vars[key] = value;
      changes.push(`${key}=${value}`);
    }
  }

  const smtpPass = process.env.SMTP_PASS?.trim();
  if (smtpPass && vars.SMTP_PASS !== smtpPass) {
    vars.SMTP_PASS = smtpPass;
    changes.push("SMTP_PASS=updated from env");
  } else if (!vars.SMTP_PASS?.trim()) {
    console.log("SMTP_PASS not in env and not on Render — add Gmail app password in dashboard.");
  }

  const captchaDefaults = {
    PUBLIC_URL: serviceUrl,
    PRICE_CAPTCHA_SUBMIT: "$0.050",
    PRICE_CAPTCHA_BYPASS: "$0.075",
    CAPTCHA_TASK_TTL_SEC: "3600",
    CAPTCHA_POLL_TIMEOUT_MS: "300000",
    CAPTCHA_POLL_INTERVAL_MS: "2000",
  };
  for (const [key, value] of Object.entries(captchaDefaults)) {
    if (!vars[key]?.trim() || key === "PUBLIC_URL") {
      if (vars[key] !== value) {
        vars[key] = value;
        changes.push(`${key}=${value}`);
      }
    }
  }

  for (const key of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "OPERATOR_SMS_NUMBER"]) {
    if (vars[key]) {
      delete vars[key];
      changes.push(`${key}=removed (Gmail-only mode)`);
    }
  }

  let upstashConsoleUrl = null;
  const redisUrl = process.env.REDIS_URL?.trim() || vars.REDIS_URL?.trim();
  if (!args["skip-redis"]) {
    if (redisUrl) {
      if (vars.REDIS_URL !== redisUrl) {
        vars.REDIS_URL = redisUrl;
        changes.push("REDIS_URL=set");
      }
    } else {
      console.log("REDIS_URL missing — provisioning free Upstash Redis for CAPTCHA storage...");
      const upstash = await ensureUpstashRedis();
      vars.REDIS_URL = upstash.redisUrl;
      upstashConsoleUrl = upstash.consoleUrl;
      changes.push("REDIS_URL=provisioned via Upstash start-redis");
    }
  }

  console.log("");
  console.log("Planned changes:");
  for (const line of changes) console.log(`  • ${line}`);
  if (!changes.length) console.log("  • (no changes needed)");

  const missing = [];
  if (!vars.SMTP_PASS) missing.push("SMTP_PASS (Gmail app password)");
  if (!vars.REDIS_URL && !args["skip-redis"]) missing.push("REDIS_URL");
  if (missing.length) {
    console.log("");
    console.log("Still missing:");
    for (const item of missing) console.log(`  • ${item}`);
  }

  if (upstashConsoleUrl) {
    console.log("");
    console.log("Upstash trial Redis (claim within 3 days for permanent free tier):");
    console.log(`  ${upstashConsoleUrl}`);
  }

  if (args["dry-run"]) {
    console.log("");
    console.log("Dry run — no Render changes written.");
    return;
  }

  if (!changes.length) {
    console.log("");
    console.log("Render notification config already up to date.");
  } else {
    await putEnvVars(service.id, vars);
    console.log("");
    console.log("Render environment variables updated.");
  }

  if (args.redeploy) {
    const deploy = await triggerDeploy(service.id);
    const deployId = deploy.deploy?.id || deploy.id || "(unknown)";
    console.log(`Deploy triggered: ${deployId}`);
    console.log("Watch progress in Render → Logs.");
  } else if (changes.length) {
    console.log("");
    console.log("Redeploy required for env changes to take effect:");
    console.log("  npm run render:provision-notifications -- --redeploy");
  }

  console.log("");
  console.log("Verify:");
  console.log(`  npm run render:diagnose -- ${serviceUrl}`);
  console.log("  npm run captcha:setup -- --render --test-email");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
