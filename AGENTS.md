# AGENTS.md

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
| Install agentic-wallet skill (Cursor) | `npm run skills:install` |
| Start interactive CLI REPL | `npm start` or `node index.js` |

### Agentic Wallet skill

This repo includes the Coinbase [agentic-wallet](https://github.com/coinbase/agentic-wallet-skills) Cursor skill at `.agents/skills/agentic-wallet/`. It teaches agents to operate a wallet through the [`awal`](https://www.npmjs.com/package/awal) CLI: sign-in, balances, send USDC/ETH/POL/SOL, trade, fund, x402 bazaar search/pay/monetize, and onchain SQL queries on Base.

- Restore or refresh from lockfile: `npx skills experimental_install`
- Update pinned skill copy: `npm run skills:update`
- Skill router entrypoint: `.agents/skills/agentic-wallet/SKILL.md`

### Subprojects

- `gas-oracle-mcp/`: AgentWire MCP, an x402-paid MCP server (TypeScript) that sells webhook inbox relay + real web fetch for autonomous agents (USDC micro-payments via a CDP AgentKit wallet). Install with `npm install --legacy-peer-deps` (plain `npm install` can hang resolving the AgentKit dependency graph). Run with `npm start`, verify with `npm run smoke-test` (free) and `npm run paid-test` (settles real testnet USDC payments via the CDP facilitator; auto-funds a local buyer wallet from the CDP faucet). Uses the same CDP env vars as the root project. Facilitator defaults to `https://api.cdp.coinbase.com/platform/v2/x402` per the CDP sellers quickstart.
- `lib/instadapp/`: Instadapp `dsa-connect` spell casting on supported mainnets (default **Base mainnet**, chain id `8453`). Requires a local signer via `DSA_PRIVATE_KEY`, `PRIVATE_KEY`, `MNEMONIC_PHRASE`, or a legacy `wallet_data.txt` seed. **Base Sepolia (84532) is not supported by dsa-connect.** CLI: `npm run dsa -- accounts|build|recipes|encode|cast`. REPL: `dsa accounts`, `dsa cast '<json>' --build`.

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
