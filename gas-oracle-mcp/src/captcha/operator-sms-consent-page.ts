import { escapeHtml } from "./html.js";

export interface OperatorSmsConsentPageInput {
  readonly serviceName: string;
  readonly publicUrl: string;
  readonly operatorSmsNumber?: string;
  readonly operatorEmail?: string;
}

/**
 * Public disclosure page for Twilio toll-free verification and operator SMS opt-in.
 * Served at GET /operator-sms-consent (no authentication required).
 */
export function renderOperatorSmsConsentPage(input: OperatorSmsConsentPageInput): string {
  const serviceName = escapeHtml(input.serviceName);
  const publicUrl = escapeHtml(input.publicUrl);
  const operatorSmsNumber = input.operatorSmsNumber
    ? escapeHtml(input.operatorSmsNumber)
    : "the configured operator mobile number";
  const operatorEmail = input.operatorEmail ? escapeHtml(input.operatorEmail) : null;
  const contactLine = operatorEmail
    ? `<a href="mailto:${operatorEmail}">${operatorEmail}</a>`
    : "the configured operator email on file";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${serviceName} — Operator SMS consent</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, sans-serif;
      background: #f8fafc;
      color: #0f172a;
      line-height: 1.6;
      padding: 2rem 1rem 3rem;
    }
    main {
      max-width: 720px;
      margin: 0 auto;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      padding: 2rem;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06);
    }
    h1 { margin: 0 0 0.5rem; font-size: 1.75rem; }
    .meta { color: #64748b; font-size: 0.95rem; margin-bottom: 1.5rem; }
    h2 { font-size: 1.1rem; margin: 1.75rem 0 0.5rem; }
    p, li { margin: 0.5rem 0; }
    ul { padding-left: 1.25rem; }
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: #f1f5f9;
      border-radius: 8px;
    }
    code { padding: 0.1rem 0.35rem; }
    pre {
      padding: 1rem;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <main>
    <h1>${serviceName} operator SMS consent</h1>
    <p class="meta">Service URL: <a href="${publicUrl}">${publicUrl}</a></p>

    <h2>Purpose</h2>
    <p>
      ${serviceName} sends <strong>transactional SMS alerts</strong> to a single designated human operator
      when an autonomous agent requests human-in-the-loop CAPTCHA solving. These messages are operational
      notifications only. We do not send marketing, promotions, or bulk consumer messaging.
    </p>

    <h2>How opt-in is collected</h2>
    <p>
      The business operator opts in by configuring their mobile number in the production deployment
      environment variable <code>OPERATOR_SMS_NUMBER</code>. By setting this value, the operator
      explicitly authorizes ${serviceName} to send CAPTCHA alert SMS messages to that number.
    </p>
    <ul>
      <li><strong>Configured operator number:</strong> ${operatorSmsNumber}</li>
      <li><strong>Messages are sent only</strong> to this pre-registered operator number.</li>
      <li><strong>No public signup</strong> and no messages to numbers that have not been configured by the operator.</li>
    </ul>

    <h2>Sample message</h2>
    <pre>⚠️ CAPTCHA Alert: Agent task 550e8400-e29b-41d4-a716-446655440000 is waiting. Solve here: ${publicUrl}/solve/550e8400-e29b-41d4-a716-446655440000?token=…</pre>

    <h2>Message frequency</h2>
    <p>
      Volume is low and event-driven. A message is sent only when a CAPTCHA bypass task is created.
      Expected volume is well under 100 messages per month.
    </p>

    <h2>Opt-out and help</h2>
    <ul>
      <li>Reply <strong>STOP</strong> to unsubscribe from operator alerts.</li>
      <li>Reply <strong>HELP</strong> for assistance.</li>
      <li>Contact: ${contactLine}</li>
    </ul>

    <h2>Privacy</h2>
    <p>
      SMS alerts contain a task identifier and a secure HTTPS link to the operator solve page.
      Message content is limited to what is required to complete the CAPTCHA workflow.
    </p>
  </main>
</body>
</html>`;
}
