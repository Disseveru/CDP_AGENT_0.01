#!/usr/bin/env node
/**
 * Finish AgentWire human-in-the-loop CAPTCHA operator notifications.
 *
 * 1. Validate Twilio (+ optional SMTP) env vars
 * 2. Provision Railway notification secrets (when RAILWAY_TOKEN is set)
 * 3. Submit toll-free verification (when --verify-tfn)
 * 4. Send a test operator SMS (when --test-sms)
 * 5. Check production consent page + /ready
 *
 * Usage:
 *   TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=+18... \
 *     RAILWAY_TOKEN=... npm run captcha:setup -- --redeploy --verify-tfn --test-sms
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const DEFAULTS = {
  publicUrl: "https://gas-oracle-mcp-production.up.railway.app",
  operatorSms: "+17472241814",
  consentPageUrl: "https://disseveru.github.io/CDP_AGENT_0.01/operator-sms-consent.html",
};

const { values: args } = parseArgs({
  options: {
    redeploy: { type: "boolean", default: false },
    "verify-tfn": { type: "boolean", default: false },
    "test-sms": { type: "boolean", default: false },
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

async function checkProduction() {
  console.log("\n=== Production checks ===");
  const publicUrl = (process.env.PUBLIC_URL || DEFAULTS.publicUrl).replace(/\/$/, "");

  for (const path of ["/health", "/ready"]) {
    const response = await fetch(`${publicUrl}${path}`);
    console.log(`${path}: ${response.status}`);
  }

  const consentUrl = process.env.TFV_OPT_IN_URL?.trim() || DEFAULTS.consentPageUrl;
  const consentResponse = await fetch(consentUrl);
  console.log(`consent page (${consentUrl}): ${consentResponse.status}`);
  if (consentResponse.status !== 200) {
    throw new Error(
      `Operator SMS consent page is not live at ${consentUrl}. Enable GitHub Pages or set TFV_OPT_IN_URL.`,
    );
  }
}

async function sendTestSms() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const fromNumber = process.env.TWILIO_FROM_NUMBER?.trim();
  const to = process.env.OPERATOR_SMS_NUMBER?.trim() || DEFAULTS.operatorSms;
  const publicUrl = (process.env.PUBLIC_URL || DEFAULTS.publicUrl).replace(/\/$/, "");

  if (!accountSid || !authToken || !fromNumber) {
    throw new Error("TWILIO_* env vars required for --test-sms");
  }

  const body = `⚠️ CAPTCHA Alert: Agent task test-setup is waiting. Solve here: ${publicUrl}/solve/test-setup`;
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

async function main() {
  console.log("AgentWire CAPTCHA human-in-the-loop setup");
  console.log("");

  const twilioReady = has("TWILIO_ACCOUNT_SID") && has("TWILIO_AUTH_TOKEN") && has("TWILIO_FROM_NUMBER");
  const smtpReady = has("SMTP_PASS");

  console.log("Local env:");
  console.log(`  Twilio: ${twilioReady ? "ready" : "missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER"}`);
  console.log(`  SMTP:   ${smtpReady ? "ready" : "SMTP_PASS not set (email alerts will stay disabled)"}`);
  console.log(`  Railway token: ${has("RAILWAY_TOKEN") ? "present" : "missing"}`);

  if (!twilioReady) {
    throw new Error(
      "Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER to Cursor Cloud secrets (or export locally), then re-run.",
    );
  }

  await checkProduction();

  if (has("RAILWAY_TOKEN")) {
    const provisionArgs = args.redeploy ? ["--redeploy"] : [];
    run("Railway notification provision", "railway-provision-notifications.mjs", provisionArgs);
  } else {
    console.log("\nSkipping Railway provision (no RAILWAY_TOKEN). Add secrets in Railway dashboard instead.");
  }

  if (args["verify-tfn"]) {
    run("Toll-free verification submit", "twilio-tollfree-verify.mjs", ["--submit"]);
  } else {
    console.log("\nSkipping toll-free verification (pass --verify-tfn to submit).");
  }

  if (args["test-sms"]) {
    console.log("\n=== Test operator SMS ===");
    await sendTestSms();
  }

  console.log("\nSetup complete.");
  console.log("Next: wait for Twilio toll-free approval (3–5 business days) if you submitted verification.");
  console.log(`Consent page for Twilio review: ${process.env.TFV_OPT_IN_URL?.trim() || DEFAULTS.consentPageUrl}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
