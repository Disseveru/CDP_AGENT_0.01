/**
 * Real HTTP fetch + extraction for agents that cannot browse the web themselves.
 *
 * Returns normalized text agents can reason over, plus a content hash so they
 * can cite or verify what was retrieved.
 */
import crypto from "node:crypto";

import { assertSafePublicUrl, sanitizeRequestHeaders } from "./http-safety.js";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

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
  const extraHeaders = sanitizeRequestHeaders(input.headers);

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

/** Returns raw HTML/text bytes for link extraction and other downstream tools. */
export async function fetchRawContent(input: FetchUrlInput): Promise<{
  url: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  raw: string;
  fetchedInMs: number;
}> {
  const started = Date.now();
  let current = await assertSafePublicUrl(input.url);
  const extraHeaders = sanitizeRequestHeaders(input.headers);

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
  const { bytes } = await readResponseBody(res);
  const charset = contentType?.match(/charset=([^;]+)/i)?.[1]?.trim() ?? "utf-8";

  return {
    url: input.url,
    finalUrl: current.toString(),
    status: res.status,
    contentType,
    raw: bytes.toString(charset as BufferEncoding),
    fetchedInMs: Date.now() - started,
  };
}
