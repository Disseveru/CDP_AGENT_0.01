#!/usr/bin/env node
/**
 * Close duplicate open PRs after a consolidation merge to main.
 *
 * Keeps PRs listed in --keep (comma-separated numbers). Closes everything else
 * with an explanatory comment, then deletes the remote head branch when safe.
 *
 * Usage:
 *   node scripts/consolidate-open-prs.mjs --dry-run
 *   node scripts/consolidate-open-prs.mjs --apply
 *   node scripts/consolidate-open-prs.mjs --apply --keep 124
 */
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    keep: { type: "string", default: "" },
  },
});

const dryRun = args["dry-run"] || !args.apply;
const REPO = process.env.GITHUB_REPOSITORY?.trim() || "Disseveru/CDP_AGENT_0.01";
const keep = new Set(
  (args.keep ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number),
);

const CLOSE_COMMENT = `Auto-closed during repo consolidation (security fixes merged to main).

Duplicate of work now on \`main\` from the consolidation PR. If something here is still needed, reopen with a fresh branch against current \`main\`.`;

function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `gh ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function main() {
  const json = gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,headRefName"]);
  const prs = JSON.parse(json);
  let closed = 0;
  let skipped = 0;

  console.log(`Open PRs: ${prs.length}`);
  console.log(dryRun ? "DRY RUN — pass --apply to close PRs" : "APPLYING closes");

  for (const pr of prs) {
    if (keep.has(pr.number)) {
      console.log(`keep #${pr.number}: ${pr.title}`);
      skipped += 1;
      continue;
    }

    console.log(`${dryRun ? "would close" : "closing"} #${pr.number} (${pr.headRefName}): ${pr.title}`);
    if (!dryRun) {
      try {
        gh(["pr", "close", String(pr.number), "--comment", CLOSE_COMMENT]);
      } catch {
        gh(["pr", "close", String(pr.number)]);
      }
      try {
        gh(["api", "-X", "DELETE", `repos/${REPO}/git/refs/heads/${pr.headRefName}`]);
        console.log(`  deleted branch ${pr.headRefName}`);
      } catch (error) {
        console.log(`  branch delete skipped: ${error.message}`);
      }
      closed += 1;
    }
  }

  console.log("");
  console.log(dryRun ? `Would close ${prs.length - skipped} PR(s), keep ${skipped}` : `Closed ${closed} PR(s), kept ${skipped}`);
}

main();
