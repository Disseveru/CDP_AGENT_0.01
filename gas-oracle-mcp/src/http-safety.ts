/**
 * SSRF guards shared by fetch_url, relay_post, and extract_links.
 */
import dns from "node:dns/promises";
import net from "node:net";

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

const BLOCKED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
]);

export function sanitizeRequestHeaders(headers?: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  if (!headers) return sanitized;

  for (const [key, value] of Object.entries(headers)) {
    if (!BLOCKED_REQUEST_HEADERS.has(key.toLowerCase())) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
