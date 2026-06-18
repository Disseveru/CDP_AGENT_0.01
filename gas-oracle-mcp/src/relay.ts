/**
 * Outbound HTTP relay for agents that cannot make direct outbound requests.
 *
 * Supports POST/PUT/PATCH with SSRF protection matching fetch_url.
 */
import { assertSafePublicUrl, sanitizeRequestHeaders } from "./http-safety.js";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 20_000;

const ALLOWED_METHODS = new Set(["POST", "PUT", "PATCH"]);

export interface RelayPostInput {
  url: string;
  method?: "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  body?: unknown;
}

export interface RelayPostResult {
  timestamp: string;
  url: string;
  method: string;
  status: number;
  contentType: string | null;
  responseBody: unknown;
  responseText: string | null;
  relayedInMs: number;
}

function serializeBody(body: unknown): { payload: string | undefined; contentType?: string } {
  if (body === undefined || body === null) {
    return { payload: undefined };
  }
  if (typeof body === "string") {
    return { payload: body };
  }
  return { payload: JSON.stringify(body), contentType: "application/json" };
}

async function readLimitedText(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > maxBytes) {
      const allowed = maxBytes - (total - value.length);
      if (allowed > 0) chunks.push(value.slice(0, allowed));
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
}

/** Relays an outbound HTTP request to a public URL on behalf of an agent. */
export async function relayPost(input: RelayPostInput): Promise<RelayPostResult> {
  const started = Date.now();
  const parsed = await assertSafePublicUrl(input.url);
  const method = (input.method || "POST").toUpperCase();

  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`Method ${method} is not allowed. Use POST, PUT, or PATCH.`);
  }

  const { payload, contentType } = serializeBody(input.body);
  if (payload && Buffer.byteLength(payload, "utf8") > MAX_BODY_BYTES) {
    throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  const extraHeaders = sanitizeRequestHeaders(input.headers);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(parsed.toString(), {
      method,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "AgentWire/1.0 (x402 MCP; +https://x402.org)",
        Accept: "application/json,text/plain,*/*;q=0.8",
        ...(contentType ? { "Content-Type": contentType } : {}),
        ...extraHeaders,
      },
      body: payload,
    });
  } finally {
    clearTimeout(timer);
  }

  const responseContentType = res.headers.get("content-type");
  const responseText = await readLimitedText(res, MAX_RESPONSE_BYTES);

  let responseBody: unknown = responseText;
  if (responseContentType?.includes("application/json")) {
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = responseText;
    }
  }

  return {
    timestamp: new Date().toISOString(),
    url: input.url,
    method,
    status: res.status,
    contentType: responseContentType,
    responseBody,
    responseText: typeof responseBody === "string" ? responseBody : null,
    relayedInMs: Date.now() - started,
  };
}
