#!/usr/bin/env node
/**
 * Sync normalized CDP credentials from local env (Cursor secrets) to Render.
 *
 * Fixes invalid_private_key on Render when CDP_PRIVATE_KEY was pasted with
 * stray whitespace or broken PEM formatting.
 *
 * Usage:
 *   npm run render:fix-cdp
 *   npm run render:fix-cdp -- --redeploy
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  findService,
  getEnvVars,
  getRenderApiKey,
  putEnvVars,
  servicePublicUrl,
  triggerDeploy,
} from "./render-api.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const DEFAULT_URL = "https://cdp-agent-0-01.onrender.com";
const CANONICAL_PAY_TO = "0xed7d30e8bc643503f9da261ed8e623bb6ecf6189";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    redeploy: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

function loadNormalizedCdpFromLocal() {
  const tsxPath = join(repoRoot, "gas-oracle-mcp", "node_modules", ".bin", "tsx");
  const script = `
process.env.OPERATOR_SMS_NUMBER = process.env.OPERATOR_SMS_NUMBER || "+17472241814";
delete process.env.RAILWAY_ENVIRONMENT;
const { diagnoseCdpApiCredentials, resolveCdpApiCredentials } = await import("./src/wallet.ts");
const d = diagnoseCdpApiCredentials();
if (d.issue !== "ok") {
  console.error(JSON.stringify({ error: d.issue }));
  process.exit(1);
}
const creds = resolveCdpApiCredentials();
const walletSecret = process.env.CDP_WALLET_SECRET?.trim();
if (!creds || !walletSecret) {
  console.error(JSON.stringify({ error: "missing_local_creds" }));
  process.exit(1);
}
console.log(JSON.stringify({
  apiKeyId: creds.apiKeyId,
  privateKeyOneLine: creds.apiKeySecret.replace(/\\n/g, "\\\\n"),
  walletSecret,
}));
`;

  const result = spawnSync(tsxPath, ["--input-type=module", "-e", script], {
    cwd: join(repoRoot, "gas-oracle-mcp"),
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });

  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || "unknown";
    throw new Error(`Local CDP credentials invalid or missing: ${detail}`);
  }

  const jsonLine = result.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .at(-1);
  if (!jsonLine) {
    throw new Error(`Could not parse local CDP credential output: ${result.stdout}`);
  }

  return JSON.parse(jsonLine);
}

async function main() {
  if (!getRenderApiKey()) {
    throw new Error("RENDER_API_KEY is required.");
  }

  const targetUrl = (positionals[0] || DEFAULT_URL).replace(/\/$/, "");
  const local = loadNormalizedCdpFromLocal();

  let service = await findService({ url: targetUrl });
  if (!service) service = await findService({ name: "CDP_AGENT_0.01" });
  if (!service) throw new Error(`No Render service for ${targetUrl}`);

  const serviceUrl = servicePublicUrl(service) || targetUrl;
  const vars = await getEnvVars(service.id);

  vars.CDP_API_KEY = local.apiKeyId;
  vars.CDP_PRIVATE_KEY = local.privateKeyOneLine;
  vars.CDP_WALLET_SECRET = local.walletSecret;
  vars.PAY_TO_ADDRESS = CANONICAL_PAY_TO;
  vars.FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
  vars.NETWORK = "base";
  if (!vars.PUBLIC_URL?.trim()) vars.PUBLIC_URL = serviceUrl;

  console.log("Render CDP credential fix");
  console.log(`Service: ${service.name} (${service.id})`);
  console.log(`CDP_API_KEY: ${local.apiKeyId.slice(0, 12)}...`);
  console.log(`CDP_PRIVATE_KEY: normalized PEM (single line with \\\\n)`);
  console.log(`PAY_TO_ADDRESS: ${CANONICAL_PAY_TO}`);

  if (args["dry-run"]) {
    console.log("Dry run — no Render changes.");
    return;
  }

  await putEnvVars(service.id, vars);
  console.log("Render CDP variables updated.");

  if (args.redeploy) {
    const deploy = await triggerDeploy(service.id);
    console.log(`Deploy triggered: ${deploy.deploy?.id || deploy.id || "(unknown)"}`);
  } else {
    console.log("Redeploy with: npm run render:fix-cdp -- --redeploy");
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
