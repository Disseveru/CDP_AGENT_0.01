import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export function createStreamableMcpTransport(
  serverUrl = process.env.SERVER_URL || "http://localhost:4021/mcp",
): StreamableHTTPClientTransport {
  const apiKey = process.env.MCP_API_KEY?.trim();
  const opts = apiKey
    ? { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } }
    : undefined;
  return new StreamableHTTPClientTransport(new URL(serverUrl), opts);
}
