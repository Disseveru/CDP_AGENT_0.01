import { z } from "zod";

import { CONFIG } from "../config.js";
import { renderOperatorAlertEmail } from "./email-template.js";
import { parseOperatorAlertUrls } from "./notification-config.js";
import type { CaptchaType, SanitizedOperatorAlert } from "./types.js";

export interface OperatorAlert {
  taskId: string;
  solveUrl: string;
  captchaType: CaptchaType;
  pageUrl: string;
}

const captchaTypeSchema = z.enum(["recaptcha", "hcaptcha", "turnstile"]);

const operatorAlertSchema = z.object({
  taskId: z
    .string()
    .trim()
    .min(1, "taskId is required")
    .max(128, "taskId is too long")
    .regex(/^[A-Za-z0-9_-]+$/, "taskId contains invalid characters"),
  solveUrl: z.string().trim().min(1),
  captchaType: captchaTypeSchema,
  pageUrl: z.string().trim().min(1),
});

function sanitizeOperatorAlert(alert: OperatorAlert): SanitizedOperatorAlert {
  const parsed = operatorAlertSchema.safeParse(alert);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid operator alert: ${detail}`);
  }

  const urls = parseOperatorAlertUrls({
    solveUrl: parsed.data.solveUrl,
    pageUrl: parsed.data.pageUrl,
  });

  return {
    taskId: parsed.data.taskId,
    solveUrl: urls.solveUrl,
    captchaType: parsed.data.captchaType,
    pageUrl: urls.pageUrl,
  };
}

export function buildSmsBody(alert: OperatorAlert): string {
  const safe = sanitizeOperatorAlert(alert);
  return `⚠️ CAPTCHA Alert: Agent task ${safe.taskId} is waiting. Solve here: ${safe.solveUrl}`;
}

export function buildEmailSubject(alert: OperatorAlert): string {
  const safe = sanitizeOperatorAlert(alert);
  const shortId = safe.taskId.length > 8 ? `${safe.taskId.slice(0, 8)}…` : safe.taskId;
  return `⚠️ CAPTCHA Alert: task ${shortId}`;
}

export function buildEmailHtml(alert: OperatorAlert): string {
  return renderOperatorAlertEmail(sanitizeOperatorAlert(alert));
}

function twilioMessagesUrl(accountSid: string): string {
  const { sms } = CONFIG.captcha.notifications;
  if (!sms) {
    throw new Error("Twilio SMS channel is not configured");
  }
  if (sms.accountSid !== accountSid) {
    throw new Error("Twilio account SID mismatch");
  }
  return `${sms.apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Messages.json`;
}

export async function sendSms(to: string, body: string): Promise<void> {
  const { sms, operatorSmsNumber } = CONFIG.captcha.notifications;
  if (!sms) {
    console.warn("[captcha/sms] Twilio not configured; skipping SMS");
    return;
  }

  if (to !== operatorSmsNumber) {
    throw new Error("SMS recipient does not match configured operator number");
  }

  const params = new URLSearchParams({
    To: to,
    From: sms.fromNumber,
    Body: body,
  });

  let response: Response;
  try {
    response = await fetch(twilioMessagesUrl(sms.accountSid), {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sms.accountSid}:${sms.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Twilio SMS request failed: ${message}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "(no response body)");
    throw new Error(`Twilio SMS failed (${response.status}): ${detail}`);
  }
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const { email, operatorEmail } = CONFIG.captcha.notifications;
  if (!email) {
    console.warn("[captcha/email] SMTP not configured; skipping email");
    return;
  }

  if (operatorEmail && to !== operatorEmail) {
    throw new Error("Email recipient does not match configured operator email");
  }

  let transport: import("nodemailer").Transporter;
  try {
    const nodemailer = await import("nodemailer");
    transport = nodemailer.createTransport({
      host: email.host,
      port: email.port,
      secure: email.port === 465,
      auth: { user: email.user, pass: email.pass },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SMTP transport initialization failed: ${message}`);
  }

  try {
    await transport.sendMail({ from: email.user, to, subject, html });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SMTP send failed: ${message}`);
  }
}

export async function notifyOperator(alert: OperatorAlert): Promise<void> {
  const { notifications } = CONFIG.captcha;
  const smsBody = buildSmsBody(alert);

  const promises: Promise<void>[] = [];
  if (notifications.sms) {
    promises.push(sendSms(notifications.operatorSmsNumber, smsBody));
  }

  if (notifications.email && notifications.operatorEmail) {
    promises.push(
      sendEmail(
        notifications.operatorEmail,
        buildEmailSubject(alert),
        buildEmailHtml(alert),
      ),
    );
  }

  if (promises.length === 0) {
    console.warn("[captcha/notify] No notification channels configured; operator will not be alerted");
    return;
  }

  const results = await Promise.allSettled(promises);
  for (const result of results) {
    if (result.status === "rejected") {
      const reason = result.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      console.error("[captcha/notify]", message);
    }
  }
}
