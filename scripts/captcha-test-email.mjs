#!/usr/bin/env node
/**
 * Send a test CAPTCHA operator alert email using SMTP vars from env or Render.
 *
 * Usage:
 *   SMTP_USER=... SMTP_PASS=... OPERATOR_EMAIL=... npm run captcha:test-email
 *   RENDER_API_KEY=... npm run captcha:test-email -- --from-render
 */
import { parseArgs } from "node:util";

import { findService, getEnvVars, getRenderApiKey } from "./render-api.mjs";

const DEFAULT_RENDER_URL = "https://cdp-agent-0-01.onrender.com";

const { values: args } = parseArgs({
  options: {
    "from-render": { type: "boolean", default: false },
  },
});

async function loadSmtpFromRender() {
  if (!getRenderApiKey()) {
    throw new Error("RENDER_API_KEY required for --from-render");
  }
  const service =
    (await findService({ url: DEFAULT_RENDER_URL })) ||
    (await findService({ name: "CDP_AGENT_0.01" }));
  if (!service) throw new Error("Render service not found");
  const vars = await getEnvVars(service.id);
  return {
    host: vars.SMTP_HOST || "smtp.gmail.com",
    port: Number(vars.SMTP_PORT || 587),
    user: vars.SMTP_USER,
    pass: vars.SMTP_PASS,
    to: vars.OPERATOR_EMAIL || vars.SMTP_USER,
    publicUrl: vars.PUBLIC_URL || DEFAULT_RENDER_URL,
  };
}

async function main() {
  const smtp = args["from-render"]
    ? await loadSmtpFromRender()
    : {
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: Number(process.env.SMTP_PORT || 587),
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        to: process.env.OPERATOR_EMAIL || process.env.SMTP_USER,
        publicUrl: process.env.PUBLIC_URL || DEFAULT_RENDER_URL,
      };

  if (!smtp.user || !smtp.pass || !smtp.to) {
    throw new Error("SMTP_USER, SMTP_PASS, and OPERATOR_EMAIL (or SMTP_USER) are required");
  }

  const taskId = "test-setup";
  const solveUrl = `${smtp.publicUrl.replace(/\/$/, "")}/solve/${taskId}?token=test`;
  const subject = "⚠️ CAPTCHA Alert: task test-set…";
  const html = `<p>Test CAPTCHA operator alert from AgentWire setup.</p>
<p><a href="${solveUrl}">Solve here</a></p>
<p>Target page: https://example.com/login</p>`;

  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });

  await transport.sendMail({
    from: smtp.user,
    to: smtp.to,
    subject,
    html,
  });

  console.log(`Test CAPTCHA alert email sent to ${smtp.to}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
