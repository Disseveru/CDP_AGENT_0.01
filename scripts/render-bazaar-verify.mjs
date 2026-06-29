#!/usr/bin/env node
/**
 * Verify AgentWire on Render meets CDP x402 Bazaar seller requirements and
 * optionally trigger a CDP settlement for indexing.
 *
 * Usage:
 *   npm run render:bazaar-verify
 *   npm run render:bazaar-verify -- --settle
 *   npm run render:bazaar-verify -- https://cdp-agent-0-01.onrender.com --settle
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findService, getEnvVars, getRenderApiKey } from "./render-api.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const secretsPath = join(repoRoot, ".cursor", "mcp-setup.secrets.json");
const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const DEFAULT_URL = "https://cdp-agent-0-01.onrender.com";

function loadLocalConfig() {
  if (existsSync(secretsPath)) {
    const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
    return {
      publicUrl:
        secrets.publicUrl?.replace(/\/$/, "") ||
        secrets.renderUrl?.replace(/\/$/, "") ||
        DEFAULT_URL,
      mcpApiKey: secrets.mcpApiKey,
    };
  }
  return { publicUrl: DEFAULT_URL, mcpApiKey: process.env.MCP_API_KEY };
}

function decodePaymentRequired(header) {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function validateBazaarExtension(bazaar, label) {
  const tsxPath = join(repoRoot, "gas-oracle-mcp", "node_modules", ".bin", "tsx");
  const result = spawnSync(
    tsxPath,
    [
      "--input-type=module",
      "-e",
      `import { validateDiscoveryExtensionSpec } from "@x402/extensions/bazaar";
       const ext = ${JSON.stringify(bazaar)};
       const v = validateDiscoveryExtensionSpec(ext);
       if (!v.valid) { console.error(JSON.stringify(v.errors)); process.exit(1); }
       console.log("ok");`,
    ],
    { cwd: join(repoRoot, "gas-oracle-mcp"), encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`${label} failed Bazaar spec validation: ${result.stderr || result.stdout}`);
  }
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`OK  ${name}`);
    return true;
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message || error}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const shouldSettle = process.argv.includes("--settle");
  const { publicUrl, mcpApiKey } = loadLocalConfig();
  const targetUrl = (args[0] || publicUrl).replace(/\/$/, "");

  console.log("AgentWire x402 Bazaar compliance check");
  console.log(`URL: ${targetUrl}`);
  console.log("");

  const results = [];

  results.push(
    await check("GET / returns 402 (not 401/403) for unpaid buyers", async () => {
      const res = await fetch(`${targetUrl}/`, { signal: AbortSignal.timeout(60_000) });
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Auth runs before x402 on GET / (${res.status}). Buyers cannot discover this endpoint.`,
        );
      }
      if (res.status !== 402) {
        throw new Error(`Expected 402, got ${res.status}`);
      }
    }),
  );

  results.push(
    await check("CDP facilitator in discovery challenge", async () => {
      const res = await fetch(`${targetUrl}/`, { signal: AbortSignal.timeout(60_000) });
      const paymentRequired = decodePaymentRequired(res.headers.get("payment-required"));
      const example = paymentRequired?.extensions?.bazaar?.info?.output?.example;
      const exampleFacilitator = example?.facilitator;
      if (!exampleFacilitator?.includes("api.cdp.coinbase.com")) {
        throw new Error(
          `Discovery card facilitator is "${exampleFacilitator || "(missing)"}" — expected CDP ${CDP_FACILITATOR_URL}`,
        );
      }
    }),
  );

  results.push(
    await check("x402 v2 PaymentRequired envelope (wizard shape)", async () => {
      const res = await fetch(`${targetUrl}/`, { signal: AbortSignal.timeout(60_000) });
      const paymentRequired = decodePaymentRequired(res.headers.get("payment-required"));
      if (!paymentRequired) throw new Error("Missing payment-required header");
      if (paymentRequired.x402Version !== 2) {
        throw new Error(`Expected x402Version 2, got ${paymentRequired.x402Version}`);
      }
      if (!paymentRequired.error) throw new Error("Missing error field on PaymentRequired");
      if (!paymentRequired.resource?.url) throw new Error("Missing resource.url");
      if (!paymentRequired.resource?.mimeType) throw new Error("Missing resource.mimeType");
      const accept = paymentRequired.accepts?.[0];
      if (!accept) throw new Error("Missing accepts[0]");
      if (Number(accept.amount) < 1000) {
        throw new Error(`accepts[0].amount must be >= 1000 atomic units, got ${accept.amount}`);
      }
      if (!accept.payTo) throw new Error("Missing accepts[0].payTo");
      if (!accept.network?.includes("8453")) {
        throw new Error(`Expected Base mainnet network, got ${accept.network}`);
      }
    }),
  );

  results.push(
    await check("Bazaar discovery extension on GET /", async () => {
      const res = await fetch(`${targetUrl}/`, { signal: AbortSignal.timeout(60_000) });
      const paymentRequired = decodePaymentRequired(res.headers.get("payment-required"));
      if (!paymentRequired?.extensions?.bazaar) {
        throw new Error("Missing extensions.bazaar on discovery PaymentRequired");
      }
      await validateBazaarExtension(paymentRequired.extensions.bazaar, "GET /");
      if (!paymentRequired.resource.url.startsWith(targetUrl)) {
        throw new Error(
          `Resource URL mismatch: ${paymentRequired.resource.url} vs ${targetUrl}/`,
        );
      }
    }),
  );

  results.push(
    await check("/ready uses CDP payments (not fallback facilitator)", async () => {
      const res = await fetch(`${targetUrl}/ready`, { signal: AbortSignal.timeout(60_000) });
      const body = await res.json();
      if (body.status !== "ready") {
        throw new Error(`ready status=${body.status} error=${body.error || "?"}`);
      }
      if (!body.paymentsAvailable) {
        throw new Error("paymentsAvailable=false — CDP facilitator may have failed");
      }
    }),
  );

  const apiKey = getRenderApiKey();
  if (apiKey) {
    const service = await findService({ url: targetUrl });
    if (service) {
      const vars = await getEnvVars(service.id);
      results.push(
        await check("Render FACILITATOR_URL points at CDP", async () => {
          const facilitator = vars.FACILITATOR_URL || CDP_FACILITATOR_URL;
          if (!facilitator.includes("api.cdp.coinbase.com")) {
            throw new Error(`FACILITATOR_URL=${facilitator}`);
          }
        }),
      );
      results.push(
        await check("Render CDP API credentials present", async () => {
          if (!vars.CDP_API_KEY || !vars.CDP_PRIVATE_KEY) {
            throw new Error("CDP_API_KEY or CDP_PRIVATE_KEY missing on Render");
          }
        }),
      );
    }
  } else {
    console.log("SKIP Render env checks (RENDER_API_KEY unset)");
  }

  console.log("");
  if (!results.every(Boolean)) {
    console.log("Bazaar compliance checks failed. Fix the items above before settling.");
    process.exit(1);
  }

  console.log("All Bazaar compliance checks passed.");
  console.log("");
  console.log("CDP indexing requirements:");
  console.log("  • bazaarResourceServerExtension + declareDiscoveryExtension — implemented in code");
  console.log("  • CDP facilitator URL — configured");
  console.log("  • paymentPayload.resource — set on all paid routes/tools");
  console.log("  • At least one CDP settlement — required for auto-indexing");
  console.log("  • Activity every 30 days — keep one paid call/month to stay visible");

  if (!shouldSettle) {
    console.log("");
    console.log("Run with --settle to complete a CDP mainnet payment and trigger indexing:");
    console.log("  npm run render:bazaar-verify -- --settle");
    return;
  }

  if (!mcpApiKey) {
    throw new Error("MCP_API_KEY missing locally. Run npm run setup:cursor-mcp first.");
  }

  console.log("");
  console.log("Triggering CDP settlement on production (GET / discovery)...");
  const tsxPath = join(repoRoot, "gas-oracle-mcp", "node_modules", ".bin", "tsx");
  const settleEnv = {
    ...process.env,
    SERVER_URL: `${targetUrl}/mcp`,
    MCP_API_KEY: mcpApiKey,
    OPERATOR_SMS_NUMBER: process.env.OPERATOR_SMS_NUMBER || "+17472241814",
  };
  const settle = spawnSync(
    tsxPath,
    ["scripts/production-bazaar-settle.ts", "--mcp"],
    {
      cwd: join(repoRoot, "gas-oracle-mcp"),
      stdio: "inherit",
      env: settleEnv,
    },
  );
  if (settle.status !== 0) {
    process.exit(settle.status || 1);
  }

  console.log("");
  console.log("Searching x402 Bazaar for AgentWire resources...");
  const search = spawnSync(
    "npx",
    ["awal@2.10.0", "x402", "bazaar", "search", "agentwire webhook inbox", "--network", "base", "--json"],
    { cwd: repoRoot, encoding: "utf8", env: process.env },
  );
  if (search.status === 0 && search.stdout) {
    try {
      const hits = JSON.parse(search.stdout);
      const matches = Array.isArray(hits)
        ? hits.filter((item) => JSON.stringify(item).includes("onrender.com"))
        : [];
      if (matches.length) {
        console.log(`Found ${matches.length} Bazaar hit(s) referencing this host.`);
      } else {
        console.log(
          "No onrender.com hits yet — CDP indexing can take a few minutes after the first settlement.",
        );
      }
    } catch {
      console.log(search.stdout.trim());
    }
  } else {
    console.log("Bazaar search skipped or unavailable (awal not signed in is OK for this step).");
    if (search.stderr) console.log(search.stderr.trim());
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
