#!/usr/bin/env node
/**
 * Sync the Agentic Market SKILL.md from the canonical install URL into the repo.
 *
 * Usage:
 *   npm run skills:sync:agentic-market
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const skillDir = join(repoRoot, ".agents", "skills", "agentic-market");
const skillPath = join(skillDir, "SKILL.md");

const SOURCE_URL =
  process.env.AGENTIC_MARKET_SKILL_URL ||
  "https://agentic.market/SKILL.md?source=home_cta&install_id=b803148b-f1b6-453e-9695-278c61145869";

const FRONTMATTER = `---
name: agentic-market
description: "Agentic Market x402 paid services and Agentic Wallet setup. Use on every new session to bootstrap payments, discover paid APIs at agentic.market, sign in with awal, fund the wallet, search services, and call paid endpoints. Trigger when the user needs paid agent capabilities, x402 payments, Agentic Wallet, Agentic Market, bazaar search, or external paid APIs."
user-invocable: true
disable-model-invocation: false
allowed-tools: ["Bash(npx awal@2.10.0 *)", "Bash(npx awal *)", "Bash(npx skills *)", "Bash(npm run skills:*)", "Bash(curl *)", "Bash(node scripts/*)"]
metadata:
  sourceUrl: "${SOURCE_URL}"
  installId: "b803148b-f1b6-453e-9695-278c61145869"
---

`;

function extractBody(markdown) {
  if (markdown.startsWith("---")) {
    const end = markdown.indexOf("---", 3);
    if (end !== -1) {
      return markdown.slice(end + 3).replace(/^\s+/, "");
    }
  }
  return markdown.replace(/^\s+/, "");
}

async function main() {
  let remote;
  try {
    const res = await fetch(SOURCE_URL);
    if (!res.ok) {
      throw new Error(`Failed to fetch Agentic Market skill: ${res.status} ${res.statusText}`);
    }
    remote = await res.text();
  } catch (error) {
    if (existsSync(skillPath)) {
      console.warn(
        `Agentic Market skill sync skipped (${error.message || error}). Using committed ${skillPath}.`,
      );
      return;
    }
    throw error;
  }
  const body = extractBody(remote);
  const next = `${FRONTMATTER}${body.endsWith("\n") ? body : `${body}\n`}`;

  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillPath, next, "utf8");

  const hash = createHash("sha256").update(next).digest("hex");
  console.log(`Synced ${skillPath}`);
  console.log(`Source: ${SOURCE_URL}`);
  console.log(`SHA-256: ${hash}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
