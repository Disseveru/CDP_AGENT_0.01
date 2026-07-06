#!/usr/bin/env node
/**
 * Delete stale remote cursor/* branches that no longer have open PRs.
 *
 * Usage:
 *   node scripts/cleanup-stale-branches.mjs --dry-run
 *   node scripts/cleanup-stale-branches.mjs --apply
 */
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const dryRun = args["dry-run"] || !args.apply;

function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `gh ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function main() {
  const openBranches = new Set(
    JSON.parse(gh(["pr", "list", "--state", "open", "--json", "headRefName"])).map((pr) => pr.headRefName),
  );

  const remoteBranches = gh(["api", "repos/Disseveru/CDP_AGENT_0.01/git/matching-refs/heads/cursor/"])
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).ref.replace("refs/heads/", ""));

  let deleted = 0;
  console.log(`cursor/* remote branches: ${remoteBranches.length}`);
  console.log(`open PR head branches: ${openBranches.size}`);
  console.log(dryRun ? "DRY RUN" : "APPLYING deletes");

  for (const branch of remoteBranches) {
    if (openBranches.has(branch)) {
      console.log(`keep (open PR): ${branch}`);
      continue;
    }
    console.log(`${dryRun ? "would delete" : "deleting"}: ${branch}`);
    if (!dryRun) {
      gh(["api", "-X", "DELETE", `repos/Disseveru/CDP_AGENT_0.01/git/refs/heads/${branch}`]);
      deleted += 1;
    }
  }

  console.log("");
  console.log(dryRun ? "Pass --apply to delete stale branches" : `Deleted ${deleted} branch(es)`);
}

main();
