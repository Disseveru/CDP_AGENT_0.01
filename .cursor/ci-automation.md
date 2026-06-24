# Cursor CI automation

GitHub-hosted Actions are disabled on pull requests (billing). PR CI runs through **Cursor Cloud Agent Automations** instead.

## One-time setup

1. Install the [Cursor GitHub App](https://cursor.com/docs/integrations/github) on `Disseveru/CDP_AGENT_0.01`.
2. Open [cursor.com/automations](https://cursor.com/automations) → **New automation** (or run `/automate` in Cursor).
3. Configure:
   - **Triggers:** Pull request opened, Pull request pushed
   - **Repository:** `Disseveru/CDP_AGENT_0.01`
   - **Tools:** Comment on pull request (optional: open pull request off)
4. **Prompt** (paste verbatim):

```
You are the CI gate for this repository. On the PR branch:

1. Run: bash scripts/ci.sh
2. If all steps pass, comment on the PR: "✅ Cursor CI passed (scripts/ci.sh)"
3. If anything fails, comment with the failing command output. Do not merge-breaking changes unless asked to fix them.

Use Node 22. Do not skip gas-oracle-mcp build/tests.
Read AGENTS.md if environment setup is unclear.
```

5. Save and activate the automation.

## Local / Cloud Agent manual run

```bash
npm run ci
# or
bash scripts/ci.sh
```

## Manual GitHub Actions run

`workflow_dispatch` on the **CI** workflow still works when GitHub Actions billing is available. It runs the same `scripts/ci.sh` script.
