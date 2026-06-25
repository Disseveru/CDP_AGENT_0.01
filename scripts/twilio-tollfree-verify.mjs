#!/usr/bin/env node
/**
 * Submit or inspect Twilio toll-free verification for AgentWire operator SMS.
 *
 * Requires:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER (toll-free E.164)
 *
 * Optional overrides:
 *   TFV_BUSINESS_NAME, TFV_BUSINESS_WEBSITE, TFV_NOTIFICATION_EMAIL
 *   TFV_CUSTOMER_PROFILE_SID, TFV_BUSINESS_TYPE (default SOLE_PROPRIETOR)
 *   TFV_OPT_IN_URL (default GitHub Pages operator consent HTML)
 *
 * Usage:
 *   TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=+18... \
 *     node scripts/twilio-tollfree-verify.mjs
 *   node scripts/twilio-tollfree-verify.mjs --status
 */
import { parseArgs } from "node:util";

const MESSAGING_API = "https://messaging.twilio.com/v1";
const API_2010 = "https://api.twilio.com/2010-04-01";

const DEFAULTS = {
  publicUrl: "https://gas-oracle-mcp-production.up.railway.app",
  operatorEmail: "er2k18@gmail.com",
  businessName: "AgentWire",
  messageVolume: "10",
  optInUrl:
    process.env.TFV_OPT_IN_URL?.trim() ||
    "https://disseveru.github.io/CDP_AGENT_0.01/operator-sms-consent.html",
};

const { values: args } = parseArgs({
  options: {
    status: { type: "boolean", default: false },
    submit: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function authHeader(accountSid, authToken) {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
}

async function twilioForm(url, accountSid, authToken, params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) body.append(key, item);
    } else {
      body.append(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader(accountSid, authToken),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`Twilio ${response.status}: ${json.message || json.raw || text}`);
  }
  return json;
}

async function twilioGet(url, accountSid, authToken) {
  const response = await fetch(url, {
    headers: { Authorization: authHeader(accountSid, authToken) },
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Twilio ${response.status}: ${json.message || JSON.stringify(json)}`);
  }
  return json;
}

async function findPhoneNumberSid(accountSid, authToken, e164) {
  const data = await twilioGet(
    `${API_2010}/Accounts/${accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164)}`,
    accountSid,
    authToken,
  );
  const match = data.incoming_phone_numbers?.[0];
  if (!match) {
    throw new Error(`No Twilio incoming number found for ${e164}`);
  }
  return match;
}

function buildVerificationPayload(phoneSid) {
  const publicUrl = (process.env.PUBLIC_URL || DEFAULTS.publicUrl).replace(/\/$/, "");
  const optInUrl = process.env.TFV_OPT_IN_URL?.trim() || DEFAULTS.optInUrl;
  const sampleMessage = `⚠️ CAPTCHA Alert: Agent task 550e8400-e29b-41d4-a716-446655440000 is waiting. Solve here: ${publicUrl}/solve/550e8400-e29b-41d4-a716-446655440000`;

  const payload = {
    TollfreePhoneNumberSid: phoneSid,
    BusinessName: process.env.TFV_BUSINESS_NAME?.trim() || DEFAULTS.businessName,
    BusinessWebsite: process.env.TFV_BUSINESS_WEBSITE?.trim() || publicUrl,
    NotificationEmail: process.env.TFV_NOTIFICATION_EMAIL?.trim() || DEFAULTS.operatorEmail,
    UseCaseCategories: ["ACCOUNT_NOTIFICATIONS", "SECURITY_ALERT"],
    UseCaseSummary:
      "AgentWire sends transactional SMS alerts to a single designated human operator when an autonomous agent requests human-in-the-loop CAPTCHA solving. No marketing or bulk messaging.",
    ProductionMessageSample: sampleMessage,
    OptInType: "WEB_FORM",
    OptInImageUrls: [optInUrl],
    MessageVolume: process.env.TFV_MESSAGE_VOLUME?.trim() || DEFAULTS.messageVolume,
    AdditionalInformation: `Operator opts in by configuring OPERATOR_SMS_NUMBER in the deployment environment. Public opt-in disclosure: ${optInUrl}`,
    HelpMessageSample: "Reply HELP for assistance or contact er2k18@gmail.com",
    AgeGatedContent: "false",
    BusinessType: process.env.TFV_BUSINESS_TYPE?.trim() || "SOLE_PROPRIETOR",
  };

  const profileSid = process.env.TFV_CUSTOMER_PROFILE_SID?.trim();
  if (profileSid) payload.CustomerProfileSid = profileSid;

  return payload;
}

async function listVerifications(accountSid, authToken) {
  return twilioGet(`${MESSAGING_API}/Tollfree/Verifications`, accountSid, authToken);
}

async function main() {
  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const authToken = requireEnv("TWILIO_AUTH_TOKEN");
  const fromNumber = requireEnv("TWILIO_FROM_NUMBER");

  console.log("Twilio toll-free verification");
  console.log(`From number: ${fromNumber}`);
  console.log("");

  const phone = await findPhoneNumberSid(accountSid, authToken, fromNumber);
  console.log(`Phone SID: ${phone.sid}`);
  console.log(`Friendly name: ${phone.friendly_name || "(none)"}`);
  console.log("");

  const verifications = await listVerifications(accountSid, authToken);
  const records = verifications.verifications || verifications.tollfree_verifications || [];
  if (records.length) {
    console.log("Existing verifications:");
    for (const record of records) {
      console.log(
        `  ${record.sid}  status=${record.status}  number=${record.tollfree_phone_number_sid}  edit_allowed=${record.edit_allowed ?? "?"}`,
      );
      if (record.rejection_reasons?.length) {
        for (const reason of record.rejection_reasons) {
          console.log(`    rejection: ${reason}`);
        }
      }
    }
    console.log("");
  } else {
    console.log("No existing toll-free verifications on this account.");
    console.log("");
  }

  const matching = records.find((record) => record.tollfree_phone_number_sid === phone.sid);
  if (matching && ["PENDING_REVIEW", "IN_REVIEW", "TWILIO_APPROVED"].includes(matching.status)) {
    console.log(`Verification already ${matching.status} for this number (${matching.sid}).`);
    if (!args.submit) return;
  }

  if (!args.submit && !args.status) {
    console.log("Dry run only. Re-run with --submit to create a verification request.");
    console.log("Payload preview:");
    console.log(JSON.stringify(buildVerificationPayload(phone.sid), null, 2));
    return;
  }

  if (!args.submit) return;

  const result = await twilioForm(
    `${MESSAGING_API}/Tollfree/Verifications`,
    accountSid,
    authToken,
    buildVerificationPayload(phone.sid),
  );

  console.log("Submitted toll-free verification:");
  console.log(`  SID: ${result.sid}`);
  console.log(`  Status: ${result.status}`);
  console.log(`  Notification email: ${result.notification_email || DEFAULTS.operatorEmail}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
