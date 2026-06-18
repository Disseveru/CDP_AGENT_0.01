/**
 * SSE transport smoke test for Cursor IDE remote MCP connections.
 *
 * Usage:
 *   npm run sse-test
 *   MCP_API_KEY=secret npm run sse-test -- https://your-app.up.railway.app
 */
import { config as loadEnv } from "dotenv";

loadEnv();

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const BASE_URL = (process.argv[2] || process.env.SERVER_URL || "http://localhost:4021")
  .replace(/\/+$/, "")
  .replace(/\/sse$/, "");
const MCP_API_KEY = process.env.MCP_API_KEY?.trim();

async function main(): Promise<void> {
  const headers: Record<string, string> = {};
  if (MCP_API_KEY) {
    headers.Authorization = `Bearer ${MCP_API_KEY}`;
  }

  const client = new Client({ name: "sse-test", version: "1.0.0" });
  await client.connect(
    new SSEClientTransport(new URL(`${BASE_URL}/sse`), {
      requestInit: { headers },
      eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers }) },
    }),
  );

  console.log("=== 1. listTools ===");
  const { tools } = await client.listTools();
  for (const tool of tools) {
    console.log(`- ${tool.name}`);
  }

  const names = tools.map((t) => t.name).sort();
  for (const required of ["create_inbox", "ping"]) {
    if (!names.includes(required)) {
      throw new Error(`Missing required free tool: ${required}`);
    }
  }

  console.log("\n=== 2. ping ===");
  const ping = await client.callTool({ name: "ping", arguments: {} });
  console.log((ping.content as Array<{ text: string }>)[0].text);

  await client.close();
  console.log("\nSSE TEST PASSED");
}

main().catch((error) => {
  console.error("SSE TEST FAILED:", error);
  process.exit(1);
});
