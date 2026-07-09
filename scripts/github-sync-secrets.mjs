#!/usr/bin/env node
/**
 * Safely sync secrets from the current environment to GitHub Actions.
 *
 * Values are never printed. Requires a GitHub token with repo secrets admin:
 *   GITHUB_PAT, GH_ADMIN_TOKEN, or gh auth login with a personal access token.
 *
 * Usage:
 *   npm run github:sync-secrets              # dry-run (default)
 *   npm run github:sync-secrets -- --apply   # write secrets + variables
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const manifestPath = join(repoRoot, ".github", "secrets-manifest.json");
const DEFAULT_REPO = "Disseveru/CDP_AGENT_0.01";

const apply = process.argv.includes("--apply");
const dryRun = !apply;

function loadManifest() {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function resolveEnvValue(name, aliases = {}) {
  const keys = aliases[name] ?? [name];
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function getGithubToken() {
  return (
    process.env.GITHUB_PAT?.trim() ||
    process.env.GH_PAT?.trim() ||
    process.env.GH_ADMIN_TOKEN?.trim() ||
    process.env.PERSONAL_ACCESS_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    ""
  );
}

function gh(args, { env = {} } = {}) {
  const token = getGithubToken();
  const result = spawnSync("gh", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    env: {
      ...process.env,
      ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}),
      ...env,
    },
  });
  return result;
}

function canManageSecrets(repo) {
  const result = gh(["api", `repos/${repo}/actions/secrets/public-key`]);
  return result.status === 0;
}

function setSecret(repo, name, value) {
  if (dryRun) {
    console.log(`  [dry-run] secret ${name}: would set (${value.length} chars)`);
    return true;
  }
  const result = gh(["secret", "set", name, "--repo", repo, "--body", value]);
  if (result.status !== 0) {
    console.error(`  secret ${name}: FAILED — ${(result.stderr || result.stdout || "").trim()}`);
    return false;
  }
  console.log(`  secret ${name}: set`);
  return true;
}

function setVariable(repo, name, value) {
  if (dryRun) {
    console.log(`  [dry-run] variable ${name}: would set (${value.length} chars)`);
    return true;
  }
  const result = gh(["variable", "set", name, "--repo", repo, "--body", value]);
  if (result.status !== 0) {
    console.error(`  variable ${name}: FAILED — ${(result.stderr || result.stdout || "").trim()}`);
    return false;
  }
  console.log(`  variable ${name}: set`);
  return true;
}

async function main() {
  const manifest = loadManifest();
  const repo = process.env.GITHUB_REPOSITORY?.trim() || DEFAULT_REPO;

  console.log(`GitHub secrets sync → ${repo}`);
  console.log(dryRun ? "Mode: dry-run (pass --apply to write)" : "Mode: apply");
  console.log("");

  if (!canManageSecrets(repo)) {
    console.error(
      "Cannot manage GitHub secrets with the current token (403). Add GITHUB_PAT to Cursor Cloud secrets",
    );
    console.error(
      "with repo admin scope, or run locally: gh auth login && npm run github:sync-secrets -- --apply",
    );
    process.exit(1);
  }

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  console.log("Secrets:");
  for (const name of manifest.secrets) {
    const value = resolveEnvValue(name, manifest.envAliases);
    if (!value) {
      console.log(`  secret ${name}: skip (not in environment)`);
      skipped += 1;
      continue;
    }
    if (setSecret(repo, name, value)) ok += 1;
    else failed += 1;
  }

  console.log("");
  console.log("Variables:");
  for (const [name, defaultValue] of Object.entries(manifest.variables ?? {})) {
    const value = resolveEnvValue(name) ?? defaultValue;
    if (!value) {
      console.log(`  variable ${name}: skip (no value)`);
      skipped += 1;
      continue;
    }
    if (setVariable(repo, name, value)) ok += 1;
    else failed += 1;
  }

  console.log("");
  console.log(`Done: ${ok} written, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) process.exit(1);
  if (dryRun) {
    console.log("");
    console.log("Re-run with --apply to write secrets to GitHub.");
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
