#!/usr/bin/env bash
set -euo pipefail

# Canonical CI entrypoint for Cursor Cloud Agent Automations and local runs.
# Mirrors the former GitHub Actions test job.

npm install
npm test

(
  cd gas-oracle-mcp
  npm install --legacy-peer-deps
  npm run build
  npm test
)
