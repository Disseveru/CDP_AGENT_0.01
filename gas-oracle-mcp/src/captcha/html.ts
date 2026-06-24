/** Escape text for safe insertion into HTML text nodes. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape text for safe insertion into double-quoted HTML attributes. */
export function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}

/** Allow only https URLs in operator-facing links. */
export function sanitizeHttpsUrl(value: string, fieldName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${fieldName} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${fieldName} must use https`);
  }
  return parsed.toString();
}

/** Allow http or https absolute URLs (e.g. agent-submitted page targets). */
export function sanitizeHttpUrl(value: string, fieldName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${fieldName} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${fieldName} must use http or https`);
  }
  return parsed.toString();
}
