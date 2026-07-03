#!/usr/bin/env node
/**
 * Finish AgentWire human-in-the-loop CAPTCHA operator notifications.
 *
 * Railway (SMS + email): validate Twilio (+ optional SMTP), provision Railway secrets.
 * Render (Gmail-only): provision SMTP + Redis on Render without Twilio.
 *
 * Usage:
 *   # Railway (Twilio required)
 *   TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=+18... \
 *     RAILWAY_TOKEN=... npm run captcha:setup -- --redeploy --verify-tfn --test-sms
 *
 *   # Render (Gmail-only, no Twilio)
 *   RENDER_API_KEY=... npm run captcha:setup -- --render --redeploy --test-email
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const RAILWAY_DEFAULTS = {
  publicUrl: "https://gas-oracle-mcp-production.up.railway.app",
  operatorSms: process.env.OPERATOR_SMS_NUMBER?.trim(),
  consentPageUrl: "https://gas-oracle-mcp-production.up.railway.app/operator-sms-consent",
};

const RENDER_DEFAULTS = {
  publicUrl: "https://cdp-agent-0-01.onrender.com",
};

const { values: args } = parseArgs({
  options: {
    render: { type: "boolean", default: false },
    redeploy: { type: "boolean", default: false },
    "verify-tfn": { type: "boolean", default: false },
    "test-sms": { type: "boolean", default: false },
    "test-email": { type: "boolean", default: false },
  },
});

function has(name) {
  return Boolean(process.env[name]?.trim());
}

function run(label, script, extraArgs = []) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync("node", [join(repoRoot, "scripts", script), ...extraArgs], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status})`);
  }
}

async function checkProduction(publicUrl) {
  console.log("\n=== Production checks ===");
  const base = publicUrl.replace(/\/$/, "");

  for (const path of ["/health", "/ready"]) {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(120_000) });
    const body = await response.text();
    console.log(`${path}: ${response.status} ${body.slice(0, 120)}`);
  }
}

async function sendTestSms(publicUrl) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const fromNumber = process.env.TWILIO_FROM_NUMBER?.trim();
  const to = process.env.OPERATOR_SMS_NUMBER?.trim() || RAILWAY_DEFAULTS.operatorSms;
  const base = publicUrl.replace(/\/$/, "");

  if (!accountSid || !authToken || !fromNumber) {
    throw new Error("TWILIO_* env vars required for --test-sms");
  }
  if (!to) {
    throw new Error("OPERATOR_SMS_NUMBER required for --test-sms");
  }

  const body = `⚠️ CAPTCHA Alert: Agent task test-setup is waiting. Solve here: ${base}/solve/test-setup`;
  const params = new URLSearchParams({ To: to, From: fromNumber, Body: body });
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
  );

  const detail = await response.text();
  if (!response.ok) {
    throw new Error(`Test SMS failed (${response.status}): ${detail}`);
  }
  console.log(`Test SMS queued to ${to}`);
}

async function checkRailwayConsent() {
  const consentUrl = process.env.TFV_OPT_IN_URL?.trim() || RAILWAY_DEFAULTS.consentPageUrl;
  const consentResponse = await fetch(consentUrl);
  console.log(`consent page (${consentUrl}): ${consentResponse.status}`);
  if (consentResponse.status !== 200) {
    throw new Error(
      `Operator SMS consent page is not live at ${consentUrl}. Enable GitHub Pages or set TFV_OPT_IN_URL.`,
    );
  }
}

async function setupRender() {
  const publicUrl = process.env.PUBLIC_URL || RENDER_DEFAULTS.publicUrl;
  const smtpReady = has("SMTP_PASS");

  console.log("AgentWire CAPTCHA setup — Render (Gmail-only, no Twilio)");
  console.log("");
  console.log("Local env:");
  console.log(`  SMTP_PASS: ${smtpReady ? "present" : "not in env (using Render dashboard value)"}`);
  console.log(`  REDIS_URL: ${has("REDIS_URL") ? "present" : "will provision Upstash if missing on Render"}`);
  console.log(`  RENDER_API_KEY: ${has("RENDER_API_KEY") ? "present" : "missing"}`);

  if (!has("RENDER_API_KEY")) {
    throw new Error("RENDER_API_KEY is required for --render setup.");
  }

  const provisionArgs = [];
  if (args.redeploy) provisionArgs.push("--redeploy");
  run("Render notification provision", "render-provision-notifications.mjs", [
    publicUrl,
    ...provisionArgs,
  ]);

  await checkProduction(publicUrl);

  if (args["test-email"]) {
    run("Test operator email", "captcha-test-email.mjs", ["--from-render"]);
  } else {
    console.log("\nSkipping test email (pass --test-email to send a Gmail alert).");
  }

  console.log("\nRender Gmail-only CAPTCHA setup complete.");
  console.log("Operator alerts go to OPERATOR_EMAIL via Gmail SMTP.");
  console.log("Claim your Upstash Redis in the console URL printed above (free tier, no expiry).");
}

async function setupRailway() {
  const publicUrl = process.env.PUBLIC_URL || RAILWAY_DEFAULTS.publicUrl;
  const twilioReady = has("TWILIO_ACCOUNT_SID") && has("TWILIO_AUTH_TOKEN") && has("TWILIO_FROM_NUMBER");
  const smtpReady = has("SMTP_PASS");

  console.log("AgentWire CAPTCHA human-in-the-loop setup — Railway");
  console.log("");
  console.log("Local env:");
  console.log(`  Twilio: ${twilioReady ? "ready" : "missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER"}`);
  console.log(`  SMTP:   ${smtpReady ? "ready" : "SMTP_PASS not set (email alerts will stay disabled)"}`);
  console.log(`  Railway token: ${has("RAILWAY_TOKEN") ? "present" : "missing"}`);

  if (!twilioReady) {
    throw new Error(
      "Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER to Cursor Cloud secrets (or export locally), then re-run. For Gmail-only on Render, use: npm run captcha:setup -- --render",
    );
  }

  await checkProduction(publicUrl);
  await checkRailwayConsent();

  if (has("RAILWAY_TOKEN")) {
    const provisionArgs = args.redeploy ? ["--redeploy"] : [];
    run("Railway notification provision", "railway-provision-notifications.mjs", provisionArgs);
  } else {
    console.log("\nSkipping Railway provision (no RAILWAY_TOKEN). Add secrets in Railway dashboard instead.");
  }

  if (args["verify-tfn"]) {
    run("Toll-free verification", "twilio-tollfree-verify.mjs", ["--verify"]);
  } else {
    console.log("\nSkipping toll-free verification (pass --verify-tfn to submit).");
  }

  if (args["test-sms"]) {
    console.log("\n=== Test operator SMS ===");
    await sendTestSms(publicUrl);
  }

  console.log("\nSetup complete.");
  console.log("Next: wait for Twilio toll-free approval (3–5 business days) if you submitted verification.");
  console.log(`Consent page for Twilio review: ${process.env.TFV_OPT_IN_URL?.trim() || RAILWAY_DEFAULTS.consentPageUrl}`);
}

async function main() {
  if (args.render) {
    await setupRender();
    return;
  }
  await setupRailway();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
