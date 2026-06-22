import { CONFIG } from "../config.js";
import type { CaptchaType } from "./types.js";

export interface OperatorAlert {
  taskId: string;
  solveUrl: string;
  captchaType: CaptchaType;
  pageUrl: string;
}

export function buildSmsBody(alert: OperatorAlert): string {
  return `⚠️ CAPTCHA Alert: Agent task ${alert.taskId} is waiting. Solve here: ${alert.solveUrl}`;
}

export function buildEmailSubject(alert: OperatorAlert): string {
  return `⚠️ CAPTCHA Alert: task ${alert.taskId.slice(0, 8)}…`;
}

export function buildEmailHtml(alert: OperatorAlert): string {
  return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;padding:1rem;">
  <h2>CAPTCHA waiting for human solve</h2>
  <p><strong>Task:</strong> ${alert.taskId}</p>
  <p><strong>Type:</strong> ${alert.captchaType}</p>
  <p><strong>Page:</strong> <a href="${alert.pageUrl}">${alert.pageUrl}</a></p>
  <p><a href="${alert.solveUrl}" style="display:inline-block;padding:12px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;">Solve now</a></p>
</body></html>`;
}

export async function sendSms(to: string, body: string): Promise<void> {
  const { accountSid, authToken, fromNumber } = CONFIG.captcha.twilio;
  if (!accountSid || !authToken || !fromNumber) {
    console.warn("[captcha/sms] Twilio not configured; skipping SMS");
    return;
  }

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

  if (!response.ok) {
    throw new Error(`Twilio SMS failed (${response.status}): ${await response.text()}`);
  }
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const { host, port, user, pass } = CONFIG.captcha.smtp;
  if (!user || !pass) {
    console.warn("[captcha/email] SMTP not configured; skipping email");
    return;
  }

  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  await transport.sendMail({ from: user, to, subject, html });
}

export async function notifyOperator(alert: OperatorAlert): Promise<void> {
  const smsBody = buildSmsBody(alert);
  const promises: Promise<void>[] = [sendSms(CONFIG.captcha.operatorSmsNumber, smsBody)];

  if (CONFIG.captcha.operatorEmail) {
    promises.push(
      sendEmail(
        CONFIG.captcha.operatorEmail,
        buildEmailSubject(alert),
        buildEmailHtml(alert),
      ),
    );
  }

  const results = await Promise.allSettled(promises);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[captcha/notify]", result.reason);
    }
  }
}
