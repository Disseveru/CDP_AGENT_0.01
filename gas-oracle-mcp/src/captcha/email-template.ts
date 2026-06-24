import { escapeHtml, escapeHtmlAttribute, sanitizeHttpUrl, sanitizeHttpsUrl } from "./html.js";
import type { SanitizedOperatorAlert } from "./types.js";

interface EmailSection {
  readonly label: string;
  readonly valueHtml: string;
}

function renderEmailSection(section: EmailSection): string {
  return `<p><strong>${escapeHtml(section.label)}:</strong> ${section.valueHtml}</p>`;
}

function renderExternalLink(href: string, label: string): string {
  const safeHref = escapeHtmlAttribute(href);
  const safeLabel = escapeHtml(label);
  return `<a href="${safeHref}">${safeLabel}</a>`;
}

function renderCallToAction(href: string, label: string): string {
  const safeHref = escapeHtmlAttribute(href);
  const safeLabel = escapeHtml(label);
  return `<a href="${safeHref}" style="display:inline-block;padding:12px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;">${safeLabel}</a>`;
}

function renderEmailDocument(title: string, bodySections: readonly string[]): string {
  const lines = [
    "<!doctype html>",
    '<html lang="en">',
    '<body style="font-family:system-ui,sans-serif;padding:1rem;">',
    `<h2>${escapeHtml(title)}</h2>`,
    ...bodySections,
    "</body>",
    "</html>",
  ];
  return lines.join("\n");
}

/**
 * Build the operator alert email from strictly typed, pre-validated alert data.
 * All dynamic values are HTML-escaped; solve links require https.
 */
export function renderOperatorAlertEmail(alert: SanitizedOperatorAlert): string {
  const solveUrl = sanitizeHttpsUrl(alert.solveUrl, "solveUrl");
  const pageUrl = sanitizeHttpUrl(alert.pageUrl, "pageUrl");

  const sections: EmailSection[] = [
    { label: "Task", valueHtml: escapeHtml(alert.taskId) },
    { label: "Type", valueHtml: escapeHtml(alert.captchaType) },
    {
      label: "Page",
      valueHtml: renderExternalLink(pageUrl, pageUrl),
    },
  ];

  const body = [
    ...sections.map(renderEmailSection),
    `<p>${renderCallToAction(solveUrl, "Solve now")}</p>`,
  ];

  return renderEmailDocument("CAPTCHA waiting for human solve", body);
}
