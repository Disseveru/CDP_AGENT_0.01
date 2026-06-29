#!/usr/bin/env node
/**
 * Upgrade AgentWire on Render from Free → Starter (no spin-down, ~$7/mo).
 * Requires a payment method on the Render account.
 *
 * Usage:
 *   RENDER_API_KEY=... npm run render:upgrade-starter
 */
import { findService, renderFetch, triggerDeploy, getRenderApiKey } from "./render-api.mjs";

const DEFAULT_URL = "https://cdp-agent-0-01.onrender.com";

async function main() {
  if (!getRenderApiKey()) {
    throw new Error("RENDER_API_KEY is unset.");
  }

  const url = (process.argv[2] || DEFAULT_URL).replace(/\/$/, "");
  const service = await findService({ url });
  if (!service) {
    throw new Error(`No Render service found for ${url}`);
  }

  const currentPlan = service.serviceDetails?.plan || "unknown";
  console.log(`Service: ${service.name} (${service.id})`);
  console.log(`Current plan: ${currentPlan}`);
  console.log("");

  if (currentPlan === "starter" || currentPlan?.startsWith("standard") || currentPlan?.startsWith("pro")) {
    console.log("Already on a paid instance type — no spin-down on idle.");
    return;
  }

  console.log("Upgrading to Starter ($7/mo, always on, no cold starts)...");
  try {
    await renderFetch(`/services/${service.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        serviceDetails: {
          plan: "starter",
        },
      }),
    });
  } catch (error) {
    const message = error.message || String(error);
    if (message.includes("402") || message.includes("payment")) {
      console.log("");
      console.log("Render needs a payment method before upgrading.");
      console.log("One-time setup in the Render app (no coding):");
      console.log("  1. Open https://dashboard.render.com/billing");
      console.log("  2. Add a card");
      console.log(`  3. Open ${service.dashboardUrl || "https://dashboard.render.com"}`);
      console.log("  4. Settings → Instance Type → Starter → Save");
      console.log("");
      console.log("Free alternative: Cursor keepalive daemon (no GitHub Actions needed)");
      console.log("  npm run render:keepalive:start");
      process.exit(1);
    }
    throw error;
  }

  const deploy = await triggerDeploy(service.id);
  console.log(`Deploy triggered: ${deploy.deploy?.id || deploy.id || "(unknown)"}`);
  console.log("Starter plan applies after deploy completes.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
