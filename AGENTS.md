# AGENTS.md

## Mandatory agent bootstrap (every session)

**Before any other work**, every agent opening this environment must:

1. Run `npm run bootstrap:agent` (syncs the Agentic Market skill and checks Agentic Wallet status).
2. Read `.agents/skills/agentic-market/SKILL.md` — canonical source:
   `https://agentic.market/SKILL.md?source=home_cta&install_id=b803148b-f1b6-453e-9695-278c61145869`
3. Follow the **CLI setup** path (Cursor Cloud Agents are shell-capable). Do not ask the user to pick CLI vs MCP.
4. If `npx awal status` is not signed in, complete sign-in and funding per the skill before calling paid services.
5. For wallet command routing after bootstrap, read `.agents/skills/agentic-wallet/SKILL.md`.

Paid external capabilities should go through Agentic Market discovery (`https://api.agentic.market/v1/services/`) and `npx awal x402 pay <url>` unless the task is specifically about this repo's AgentWire MCP server.

## Cursor Cloud specific instructions

### Project overview

Node.js CLI using **Coinbase CDP AgentKit** (`@coinbase/agentkit`) and **LangChain tool bindings** (`@coinbase/agentkit-langchain`) on **Base Sepolia**. Entry point: `index.js`.

### Required environment variables

| Variable | Purpose |
|---|---|
| `CDP_API_KEY` or `CDP_API_KEY_ID` | CDP API key ID |
| `CDP_PRIVATE_KEY` or `CDP_API_KEY_SECRET` | CDP API key private key (EC PEM; may be injected as a single line) |
| `CDP_WALLET_SECRET` | CDP wallet secret for v2 account operations |
| `BASE_PAYMASTER` | Set to `0`/`false` to disable CDP Smart Wallet + Base Paymaster (enabled by default) |
| `PAYMASTER_URL` | Optional override for the CDP Paymaster & Bundler endpoint |
| `USE_EOA_WALLET` | Set to `1`/`true` to force the standard CDP server wallet instead of Smart Wallet |
| `USE_LEGACY_WALLET` | Set to `1`/`true` to enable the legacy CDP wallet mode required by `deploy_token` |

Do not use deprecated names like `CDP_API_KEY_NAME` or `CDP_API_PRIVATEKEY`.
Cloud secret managers may inject the `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` aliases; the root CLI and AgentWire both accept them.

### Commands

| Task | Command |
|---|---|
| Install dependencies | `npm install` |
| Bootstrap Agentic Market + Wallet (every agent session) | `npm run bootstrap:agent` |
| Install agentic-wallet skill (Cursor) | `npm run skills:install` |
| Start interactive CLI REPL | `npm start` or `node index.js` |

### Agentic Market + Agentic Wallet skills

Every agent must bootstrap on session start:

```bash
npm run bootstrap:agent
```

Then read `.agents/skills/agentic-market/SKILL.md` (synced from [Agentic Market](https://agentic.market/SKILL.md?source=home_cta&install_id=b803148b-f1b6-453e-9695-278c61145869)) and follow the **CLI setup** for Agentic Wallet.

This repo also includes the Coinbase [agentic-wallet](https://github.com/coinbase/agentic-wallet-skills) Cursor skill at `.agents/skills/agentic-wallet/`. It teaches agents to operate a wallet through the [`awal`](https://www.npmjs.com/package/awal) CLI: sign-in, balances, send USDC/ETH/POL/SOL, trade, fund, x402 bazaar search/pay/monetize, and onchain SQL queries on Base.

- Sync Agentic Market skill: `npm run skills:sync:agentic-market` (also runs on `npm install` via postinstall)
- Restore or refresh from lockfile: `npx skills experimental_install`
- Update pinned skill copy: `npm run skills:update`
- Skill router entrypoints: `.agents/skills/agentic-market/SKILL.md`, `.agents/skills/agentic-wallet/SKILL.md`

### Subprojects

- `gas-oracle-mcp/`: AgentWire MCP, an x402-paid MCP server (TypeScript) that sells webhook inbox relay + real web fetch for autonomous agents (USDC micro-payments via a CDP AgentKit wallet). Install with `npm install --legacy-peer-deps` (plain `npm install` can hang resolving the AgentKit dependency graph). Run with `npm start`, verify with `npm run smoke-test` (free) and `npm run paid-test` (settles real testnet USDC payments via the CDP facilitator; auto-funds a local buyer wallet from the CDP faucet). Uses the same CDP env vars as the root project. Facilitator defaults to `https://api.cdp.coinbase.com/platform/v2/x402` per the CDP sellers quickstart.

### AgentWire on Railway (production)

| Item | Value |
|---|---|
| Public URL | `https://gas-oracle-mcp-production.up.railway.app` |
| Network | **Base mainnet** (`NETWORK=base`, chain `eip155:8453`) — real USDC, not testnet |
| MCP SSE endpoint | `https://gas-oracle-mcp-production.up.railway.app/sse` |
| Health / ready | `/health` (liveness + storage/redis status), `/ready` (CDP/x402 init) |

**Railway project services (production):**

| Service | Purpose |
|---|---|
| `gas-oracle-mcp` | AgentWire MCP (main app) |
| `Postgres` | Durable inbox storage (`DATABASE_URL` reference on MCP) |
| `Redis` | Webhook rate limiting (`REDIS_URL` via private networking) |
| `gas-oracle-mcp-volume` | Ephemeral-disk fallback mounted at `/app/gas-oracle-mcp/data` |

Provision or refresh wiring: `RAILWAY_TOKEN=... npm run railway:provision -- --redeploy`

The root CLI still defaults to **Base Sepolia** locally. Only the Railway AgentWire service runs on mainnet.

### Cursor MCP setup (for new agents)

Local setup state lives in **gitignored** files — do not commit secrets.

| File | Purpose |
|---|---|
| `.cursor/mcp-setup.secrets.json` | `railwayUrl`, `mcpApiKey`, `createdAt` — written by setup, used by verify/diagnose |
| `~/.cursor/mcp.json` | Cursor IDE MCP config (user-level, not in repo) |

**Bootstrap a new cloud agent or laptop:**

```bash
# 1. Write ~/.cursor/mcp.json and .cursor/mcp-setup.secrets.json
npm run setup:cursor-mcp -- https://gas-oracle-mcp-production.up.railway.app

# 2. If MCP_API_KEY is not yet on Railway, copy the printed value into
#    Railway → gas-oracle-mcp → Variables → MCP_API_KEY, then redeploy.
#    If Railway already has MCP_API_KEY, sync local secrets to match instead
#    (do not rotate the key unless you also update Railway).

# 3. Verify SSE auth
npm run verify:cursor-mcp

# 4. Diagnose Railway health, variables (format only), and boot-log warnings
RAILWAY_TOKEN=... npm run railway:diagnose
```

After setup: restart Cursor → **Settings → MCP** → enable **gas-oracle-mcp**. Expect tools: `create_inbox`, `drain_inbox`, `peek_inbox`, `inbox_stats`, `fetch_url`, `extract_links`, `relay_post`, `ping`.

**Railway API access from cloud agents:** `RAILWAY_TOKEN` (injected) supports **read** operations via GraphQL (logs, variables, deployments). Secret variable **writes** are blocked from this environment (403); update `CDP_*` or `MCP_API_KEY` in the Railway dashboard if credentials are corrupted.

**Known boot-log issue (2026-06-18):** Railway `CDP_API_KEY` / `CDP_PRIVATE_KEY` contain stray whitespace and fail CDP facilitator auth (401). AgentWire falls back to `https://facilitator.xpay.sh` and stays `ready`, but CDP Bazaar auto-listing needs valid CDP keys. Fix: re-paste the three CDP vars in Railway Variables (single-line PEM with `\\n` for the private key), then redeploy.

- `lib/instadapp/`: Instadapp `dsa-connect` spell casting on supported mainnets (default **Base mainnet**, chain id `8453`). Requires a local signer via `DSA_PRIVATE_KEY`, `PRIVATE_KEY`, `MNEMONIC_PHRASE`, or a legacy `wallet_data.txt` seed. **Base Sepolia (84532) is not supported by dsa-connect.** CLI: `npm run dsa -- accounts|build|recipes|encode|cast`. REPL: `dsa accounts`, `dsa cast '<json>' --build`.

#### DSA + Avocado wallet (flash-loan searcher)

The DSA stack routes execution through the **Instadapp Avocado** gas tank by default (`DSA_USE_AVOCADO=1`). The EOA derived from `DSA_PRIVATE_KEY` controls an Avocado safe; DSA spells are broadcast via `safe.sendTransactions()`.

| Variable | Default | Purpose |
|---|---|---|
| `DSA_USE_AVOCADO` | `1` (on) | Set to `0` to use CDP Smart Wallet + Paymaster for DSA gas instead |
| `DSA_PRIVATE_KEY` / `PRIVATE_KEY` / `MNEMONIC_PHRASE` | — | Local signer for DSA and Avocado safe derivation |
| `DSA_CHAIN_ID` | `8453` (Base) | Target mainnet (`42161` Arbitrum, `137` Polygon, `10` Optimism also supported) |
| `AVOCADO_SAFE_ADDRESS` | auto-pick | Override the Avocado safe; otherwise picks the highest USDC gas balance |
| `DSA_RPC_URL` | network default | Override RPC for the selected chain |

Commands:

| Task | Command |
|---|---|
| List DSA accounts | `npm run dsa:accounts` |
| Build DSA on Avocado safe | `npm run dsa -- build` |
| Scan L2 arbitrage opportunities | `npm run dsa:scan` |
| Flash-loan searcher CLI | `npm run dsa:search` (scan, gas, encode/cast-opportunity) |
| Interactive REPL | `dsa scan`, `dsa gas`, `dsa cast '<json>' --build` |

State persists to `dsa_data.json` (gitignored). The client tracks per-chain `dsaId`, `signerAddress`, and `authorityAddress` (Avocado safe) to prevent stale-id bugs after signer or safe switches.

### Runtime notes

- Wallet state persists to `wallet_data.txt` (gitignored). Delete this file to force a new wallet on the next run.
- By default the app uses `CdpSmartWalletProvider` with CDP Base Paymaster for sponsored transactions on Base Sepolia. Set `USE_EOA_WALLET=1` to use `CdpEvmWalletProvider` (CDP v2) instead, or `BASE_PAYMASTER=0` to disable paymaster.
- The paymaster URL is auto-resolved from CDP API credentials, or set `PAYMASTER_URL` to override.
- Legacy `LegacyCdpWalletProvider` remains available for `deploy_token`; use `USE_LEGACY_WALLET=1` to force this mode.
- Use `NETWORK_ID=base-mainnet USE_LEGACY_WALLET=1 npm start` to launch an ERC-20 token on Base mainnet with the root CLI.
- AgentWire answers `/health` as a Railway liveness check immediately after binding; use `/ready` to verify CDP/x402 initialization.
- Focused AgentKit tools (smart wallet): `mint`, `get_wallet_details`, `native_transfer`.
- Type `help` at the `Prompt>` REPL for commands, or `exit` to quit.
- If wallet initialization fails with `401`/`Unauthorized`, verify CDP API credentials in the Coinbase Developer Platform dashboard.
