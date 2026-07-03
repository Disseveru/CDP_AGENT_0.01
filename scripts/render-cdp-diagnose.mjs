#!/usr/bin/env node
/**
 * Diagnose CDP facilitator auth using Render env vars.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findService, getEnvVars } from "./render-api.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const DEFAULT_URL = "https://cdp-agent-0-01.onrender.com";

async function main() {
  const targetUrl = (process.argv[2] || DEFAULT_URL).replace(/\/$/, "");
  const service =
    (await findService({ url: targetUrl })) || (await findService({ name: "CDP_AGENT_0.01" }));
  if (!service) throw new Error("Render service not found");

  const vars = await getEnvVars(service.id);
  const tsxPath = join(repoRoot, "gas-oracle-mcp", "node_modules", ".bin", "tsx");

  const payload = {
    CDP_API_KEY: vars.CDP_API_KEY || "",
    CDP_PRIVATE_KEY: vars.CDP_PRIVATE_KEY || "",
    CDP_WALLET_SECRET: vars.CDP_WALLET_SECRET || "",
    SMTP_PASS: vars.SMTP_PASS || "",
    SMTP_USER: vars.SMTP_USER || "",
    OPERATOR_EMAIL: vars.OPERATOR_EMAIL || "",
  };

  const script = `
const env = ${JSON.stringify(payload)};
for (const [k, v] of Object.entries(env)) process.env[k] = v;
process.env.NETWORK = "base";
process.env.FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
process.env.RENDER = "true";
process.env.RENDER_SERVICE_TYPE = "web";
process.env.OPERATOR_EMAIL = env.OPERATOR_EMAIL || "er2k18@gmail.com";
process.env.SMTP_USER = env.SMTP_USER || env.OPERATOR_EMAIL || "er2k18@gmail.com";
delete process.env.RAILWAY_ENVIRONMENT;
process.env.MCP_API_KEY = "diagnostic-test-key";
process.env.OPERATOR_SMS_NUMBER = "+17472241814";

const { diagnoseCdpApiCredentials } = await import("./src/wallet.ts");
const { createCdpFacilitatorConfig, createResourceServer } = await import("./src/payments.ts");
const { HTTPFacilitatorClient } = await import("@x402/core/server");

const d = diagnoseCdpApiCredentials();
console.log("diagnose:", JSON.stringify(d));

const cfg = createCdpFacilitatorConfig();
console.log("facilitator config:", JSON.stringify(cfg, null, 2).slice(0, 500));

const client = new HTTPFacilitatorClient(cfg);
try {
  const kinds = await client.getSupportedKinds();
  console.log("supported kinds:", JSON.stringify(kinds));
} catch (e) {
  console.log("getSupportedKinds error:", e.message);
}

try {
  await createResourceServer();
  console.log("createResourceServer: OK");
} catch (e) {
  console.log("createResourceServer error:", e.message);
}
`;

  const result = spawnSync(tsxPath, ["--input-type=module", "-e", script], {
    cwd: join(repoRoot, "gas-oracle-mcp"),
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
