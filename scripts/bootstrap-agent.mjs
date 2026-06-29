#!/usr/bin/env node
/**
 * Mandatory agent bootstrap for Cursor Cloud and other shell-capable agents.
 *
 * 1. Sync Agentic Market SKILL.md from the canonical install URL
 * 2. Ensure agentic-wallet skill is installed
 * 3. Check awal wallet status and print next steps
 *
 * Usage:
 *   npm run bootstrap:agent
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  return result;
}

function printSection(title) {
  console.log("");
  console.log(`=== ${title} ===`);
}

function writeBootstrapMarker(awalReady) {
  const cursorDir = join(repoRoot, ".cursor");
  mkdirSync(cursorDir, { recursive: true });
  writeFileSync(
    join(cursorDir, "agent-bootstrap.json"),
    `${JSON.stringify({ lastRunAt: new Date().toISOString(), awalReady }, null, 2)}\n`,
    "utf8",
  );
}

async function main() {
  console.log("Agent bootstrap: Agentic Market + Agentic Wallet");

  printSection("1. Sync Agentic Market skill");
  const sync = run(process.execPath, ["scripts/sync-agentic-market-skill.mjs"]);
  process.stdout.write(sync.stdout || "");
  process.stderr.write(sync.stderr || "");
  if (sync.status !== 0) {
    process.exit(sync.status ?? 1);
  }

  const marketSkill = join(repoRoot, ".agents", "skills", "agentic-market", "SKILL.md");
  if (!existsSync(marketSkill)) {
    throw new Error(`Missing skill file after sync: ${marketSkill}`);
  }
  console.log("Read .agents/skills/agentic-market/SKILL.md and follow CLI setup.");

  printSection("2. Ensure agentic-wallet skill");
  const walletSkill = join(repoRoot, ".agents", "skills", "agentic-wallet", "SKILL.md");
  if (!existsSync(walletSkill)) {
    console.log("Installing agentic-wallet skill...");
    const install = run("npm", ["run", "skills:install"], { shell: true });
    process.stdout.write(install.stdout || "");
    process.stderr.write(install.stderr || "");
    if (install.status !== 0) {
      console.warn("agentic-wallet install failed; run: npm run skills:install");
    }
  } else {
    console.log("agentic-wallet skill present.");
  }

  printSection("3. Check Agentic Wallet (awal) status");
  const awal = run("npx", ["--yes", "awal@2.10.0", "status"], { shell: true });
  const awalOut = `${awal.stdout || ""}${awal.stderr || ""}`.trim();
  if (awalOut) console.log(awalOut);

  const walletReady =
    awal.status === 0 &&
    !/not authenticated/i.test(awalOut) &&
    (/signed in/i.test(awalOut) || /✓ authenticated/i.test(awalOut));

  printSection("4. CDP wallet policy");
  if (!process.env.USE_LEGACY_WALLET) {
    process.env.USE_LEGACY_WALLET = "1";
    console.log("Set USE_LEGACY_WALLET=1 for this session (reuse funded legacy wallet).");
  }
  if (!process.env.PAY_TO_ADDRESS) {
    process.env.PAY_TO_ADDRESS = "0xed7d30e8bc643503f9da261ed8e623bb6ecf6189";
    console.log(`Default PAY_TO_ADDRESS=${process.env.PAY_TO_ADDRESS}`);
  }
  const audit = run(process.execPath, ["scripts/cdp-wallet-audit.mjs"]);
  process.stdout.write(audit.stdout || "");
  process.stderr.write(audit.stderr || "");
  if (audit.status !== 0) {
    console.warn("Wallet audit failed; run: node scripts/cdp-wallet-audit.mjs");
  }

  printSection("5. Render keepalive (Cursor — not GitHub Actions)");
  const keepalive = run(process.execPath, ["scripts/start-render-keepalive.mjs"]);
  process.stdout.write(keepalive.stdout || "");
  process.stderr.write(keepalive.stderr || "");
  if (keepalive.status !== 0) {
    console.warn("Render keepalive did not start; run: npm run render:keepalive:start");
  }

  if (walletReady) {
    console.log("Wallet ready. Discover services with:");
    console.log('  curl -sS "https://api.agentic.market/v1/services/"');
    console.log("  npx awal@2.10.0 x402 bazaar search <query>");
    writeBootstrapMarker(true);
    return;
  }

  console.log("Wallet not ready yet. Follow .agents/skills/agentic-market/SKILL.md CLI setup:");
  console.log("  1. npx awal auth login <email>");
  console.log("  2. npx awal auth verify <code>");
  console.log("  3. npx awal show   # add funds if balance is zero");
  console.log("  4. npx awal balance");
  writeBootstrapMarker(false);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
