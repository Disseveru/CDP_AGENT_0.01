/**
 * Real HTTP fetch + extraction for agents that cannot browse the web themselves.
 *
 * Returns normalized text agents can reason over, plus a content hash so they
 * can cite or verify what was retrieved.
 */
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
]);

function normalizeIpv4(ip: string): string {
  if (ip.startsWith("::ffff:")) {
    const mapped = ip.slice(7);
    if (net.isIPv4(mapped)) {
      return mapped;
    }
  }
  return ip;
}

function parseNumericHostname(hostname: string): string | null {
  if (/^\d+$/.test(hostname)) {
    const num = Number(hostname);
    if (Number.isInteger(num) && num >= 0 && num <= 0xffffffff) {
      return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
    }
  }

  if (/^0x[0-9a-f]+$/i.test(hostname)) {
    const num = Number(hostname);
    if (Number.isInteger(num) && num >= 0 && num <= 0xffffffff) {
      return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
    }
  }

  return null;
}

function isPrivateIp(ip: string): boolean {
  const normalized = normalizeIpv4(ip);

  if (net.isIPv4(normalized)) {
    const parts = normalized.split(".").map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 0) return true;
    return false;
  }

  const lower = ip.toLowerCase();
  if (lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")) {
    return true;
  }
  return false;
}

/** Blocks SSRF to localhost, cloud metadata, and private networks. */
export async function assertSafePublicUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith(".localhost") || BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error("Blocked hostname");
  }

  const numericIp = parseNumericHostname(hostname);
  if (numericIp && isPrivateIp(numericIp)) {
    throw new Error("Blocked private IP address");
  }

  const literalIp = net.isIP(hostname);
  if (literalIp && isPrivateIp(hostname)) {
    throw new Error("Blocked private IP address");
  }

  if (!literalIp && !numericIp) {
    const records = await dns.lookup(hostname, { all: true });
    for (const { address } of records) {
      if (isPrivateIp(address)) {
        throw new Error(`Hostname ${hostname} resolves to blocked address ${address}`);
      }
    }
  }

  return parsed;
}

function stripHtml(html: string): { title: string | null; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/\s+/g, " ").trim()) : null;

  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  text = decodeEntities(text);
  return { title, text };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

async function readResponseBody(res: Response): Promise<{ bytes: Buffer; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: Buffer.from(""), truncated: false };

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > MAX_BYTES) {
      const allowed = MAX_BYTES - (total - value.length);
      if (allowed > 0) chunks.push(value.slice(0, allowed));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }

  return { bytes: Buffer.concat(chunks.map((c) => Buffer.from(c))), truncated };
}

export interface FetchUrlInput {
  url: string;
  /** Optional extra request headers (e.g. Accept-Language). */
  headers?: Record<string, string>;
}

export interface FetchUrlResult {
  timestamp: string;
  url: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  contentSha256: string;
  title: string | null;
  text: string;
  textLength: number;
  truncated: boolean;
  fetchedInMs: number;
}

/** Fetches a public URL and returns agent-readable text plus a content hash. */
export async function fetchUrl(input: FetchUrlInput): Promise<FetchUrlResult> {
  const started = Date.now();
  let current = await assertSafePublicUrl(input.url);

  const blockedHeaders = new Set(["host", "connection", "content-length", "transfer-encoding"]);
  const extraHeaders: Record<string, string> = {};
  if (input.headers) {
    for (const [key, value] of Object.entries(input.headers)) {
      if (!blockedHeaders.has(key.toLowerCase())) {
        extraHeaders[key] = value;
      }
    }
  }

  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      res = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "AgentWire/1.0 (x402 MCP; +https://x402.org)",
          Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
          ...extraHeaders,
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      current = await assertSafePublicUrl(new URL(location, current).toString());
      continue;
    }
    break;
  }

  if (!res) throw new Error("Fetch failed without a response");

  const contentType = res.headers.get("content-type");
  const { bytes, truncated } = await readResponseBody(res);
  const contentSha256 = crypto.createHash("sha256").update(bytes).digest("hex");

  let title: string | null = null;
  let text: string;

  const charset = contentType?.match(/charset=([^;]+)/i)?.[1]?.trim() ?? "utf-8";
  const raw = bytes.toString(charset as BufferEncoding);

  if (contentType?.includes("application/json")) {
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      text = raw;
    }
  } else if (contentType?.includes("text/html") || raw.trimStart().startsWith("<")) {
    const stripped = stripHtml(raw);
    title = stripped.title;
    text = stripped.text;
  } else {
    text = raw.replace(/\s+/g, " ").trim();
  }

  const maxText = 50_000;
  if (text.length > maxText) {
    text = `${text.slice(0, maxText)}\n\n[truncated to ${maxText} chars]`;
  }

  return {
    timestamp: new Date().toISOString(),
    url: input.url,
    finalUrl: current.toString(),
    status: res.status,
    contentType,
    contentSha256,
    title,
    text,
    textLength: text.length,
    truncated,
    fetchedInMs: Date.now() - started,
  };
}
