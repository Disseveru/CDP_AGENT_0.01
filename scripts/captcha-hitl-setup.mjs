#!/usr/bin/env node
/**
 * Finish AgentWire human-in-the-loop CAPTCHA operator notifications.
 *
 * 1. Validate Twilio (+ optional SMTP) env vars
 * 2. Provision Railway notification secrets (when RAILWAY_TOKEN is set)
 * 3. Submit toll-free verification (when --verify-tfn)
 * 4. Send a test operator SMS (when --test-sms)
 * 5. Send a test operator email (when --test-email)
 * 6. Send a test ntfy push (when --test-ntfy)
 * 7. Check production consent page + /ready
 *
 * Usage:
 *   TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=+18... \
 *     RAILWAY_TOKEN=... npm run captcha:setup -- --redeploy --verify-tfn --test-sms
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const gasOracleRequire = createRequire(join(repoRoot, "gas-oracle-mcp/package.json"));

const DEFAULTS = {
  publicUrl: "https://gas-oracle-mcp-production.up.railway.app",
  operatorSms: process.env.OPERATOR_SMS_NUMBER?.trim(),
  consentPageUrl: "https://gas-oracle-mcp-production.up.railway.app/operator-sms-consent",
};

const { values: args } = parseArgs({
  options: {
    redeploy: { type: "boolean", default: false },
    "verify-tfn": { type: "boolean", default: false },
    "test-sms": { type: "boolean", default: false },
    "test-email": { type: "boolean", default: false },
    "test-ntfy": { type: "boolean", default: false },
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
  if (!to) {
    throw new Error("OPERATOR_SMS_NUMBER required for --test-sms");
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

async function sendTestEmail() {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const to = process.env.OPERATOR_EMAIL?.trim() || user;
  const publicUrl = (process.env.PUBLIC_URL || DEFAULTS.publicUrl).replace(/\/$/, "");

  if (!user || !pass) {
    throw new Error("SMTP_USER and SMTP_PASS required for --test-email");
  }
  if (!to) {
    throw new Error("OPERATOR_EMAIL or SMTP_USER required for --test-email");
  }

  const nodemailer = gasOracleRequire("nodemailer");
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST?.trim() || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user, pass },
  });

  const solveUrl = `${publicUrl}/solve/test-email-setup?token=test`;
  await transport.sendMail({
    from: user,
    to,
    subject: "⚠️ CAPTCHA Alert: test-email-setup",
    html: `<p>AgentWire operator email test.</p><p><a href="${solveUrl}">Open solve page</a></p>`,
  });
  console.log(`Test email sent to ${to}`);
}

async function sendTestNtfy() {
  const topic = process.env.NTFY_TOPIC?.trim();
  const server = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
  const publicUrl = (process.env.PUBLIC_URL || DEFAULTS.publicUrl).replace(/\/$/, "");

  if (!topic) {
    throw new Error("NTFY_TOPIC required for --test-ntfy");
  }

  const solveUrl = `${publicUrl}/solve/test-ntfy-setup?token=test`;
  const body = `⚠️ CAPTCHA Alert: Agent task test-ntfy-setup is waiting. Solve here: ${solveUrl}`;
  const headers = {
    Title: "⚠️ CAPTCHA Alert: test-ntfy-setup",
    Priority: "urgent",
    Tags: "warning,robot",
    Click: solveUrl,
  };
  if (process.env.NTFY_TOKEN?.trim()) {
    headers.Authorization = `Bearer ${process.env.NTFY_TOKEN.trim()}`;
  }

  const response = await fetch(`${server}/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers,
    body,
  });
  if (!response.ok) {
    throw new Error(`ntfy test push failed (${response.status}): ${await response.text()}`);
  }
  console.log(`Test ntfy push sent to ${server}/${topic}`);
}

async function main() {
  console.log("AgentWire CAPTCHA human-in-the-loop setup");
  console.log("");

  const twilioReady = has("TWILIO_ACCOUNT_SID") && has("TWILIO_AUTH_TOKEN") && has("TWILIO_FROM_NUMBER");
  const smtpReady = has("SMTP_PASS") && (has("SMTP_USER") || has("OPERATOR_EMAIL"));
  const ntfyReady = has("NTFY_TOPIC");

  console.log("Local env:");
  console.log(`  Twilio: ${twilioReady ? "ready" : "missing TWILIO_* (optional — toll-free verification takes days)"}`);
  console.log(`  SMTP:   ${smtpReady ? "ready" : "set SMTP_PASS for instant Gmail alerts"}`);
  console.log(`  ntfy:   ${ntfyReady ? "ready" : "set NTFY_TOPIC for instant phone push (no carrier verification)"}`);
  console.log(`  Railway token: ${has("RAILWAY_TOKEN") ? "present" : "missing"}`);

  if (!twilioReady && !smtpReady && !ntfyReady) {
    throw new Error(
      "Configure at least one alert channel: SMTP_PASS (Gmail), NTFY_TOPIC (ntfy app), or TWILIO_* (slow toll-free verification).",
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
    run("Toll-free verification", "twilio-tollfree-verify.mjs", ["--verify"]);
  } else {
    console.log("\nSkipping toll-free verification (pass --verify-tfn to submit).");
  }

  if (args["test-sms"]) {
    if (!twilioReady) {
      throw new Error("TWILIO_* env vars required for --test-sms");
    }
    console.log("\n=== Test operator SMS ===");
    await sendTestSms();
  }

  if (args["test-email"]) {
    console.log("\n=== Test operator email ===");
    await sendTestEmail();
  }

  if (args["test-ntfy"]) {
    console.log("\n=== Test operator ntfy push ===");
    await sendTestNtfy();
  }

  console.log("\nSetup complete.");
  if (args["verify-tfn"]) {
    console.log("Next: wait for Twilio toll-free approval (3–5 business days) if you submitted verification.");
  } else if (!twilioReady) {
    console.log("Twilio skipped — using email/ntfy for operator alerts (no carrier verification wait).");
  }
  console.log(`Consent page for Twilio review: ${process.env.TFV_OPT_IN_URL?.trim() || DEFAULTS.consentPageUrl}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
