# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

Node.js CLI agent using **Coinbase CDP AgentKit** (`@coinbase/agentkit`), **LangChain** (`@coinbase/agentkit-langchain`), and **Google Gemini** (`@langchain/google-genai`) on **Base Sepolia**. Entry point: `index.js`.

### Required environment variables

| Variable | Purpose |
|---|---|
| `CDP_API_KEY` | CDP API key ID |
| `CDP_PRIVATE_KEY` | CDP API key private key (EC PEM; may be injected as a single line) |
| `CDP_WALLET_SECRET` | CDP wallet secret for v2 account operations |
| `GEMINI_API_KEY` | Google Gemini API key |
| `BASE_PAYMASTER` | Set to `0`/`false` to disable CDP Smart Wallet + Base Paymaster (enabled by default) |
| `PAYMASTER_URL` | Optional override for the CDP Paymaster & Bundler endpoint |
| `USE_EOA_WALLET` | Set to `1`/`true` to force the standard CDP server wallet instead of Smart Wallet |

Do not use deprecated names like `CDP_API_KEY_NAME` or `CDP_API_PRIVATEKEY`.

### Commands

| Task | Command |
|---|---|
| Install dependencies | `npm install` |
| Start interactive agent REPL | `npm start` or `node index.js` |

### Runtime notes

- Wallet state persists to `wallet_data.txt` (gitignored). Delete this file to force a new wallet on the next run.
- By default the app uses `CdpSmartWalletProvider` with CDP Base Paymaster for sponsored transactions on Base Sepolia. Set `USE_EOA_WALLET=1` to use `CdpEvmWalletProvider` (CDP v2) instead, or `BASE_PAYMASTER=0` to disable paymaster.
- The paymaster URL is auto-resolved from CDP API credentials, or set `PAYMASTER_URL` to override.
- Legacy `LegacyCdpWalletProvider` remains available for `deploy_token` when smart wallet and v2 are disabled.
- Focused AgentKit tools (smart wallet): `mint`, `get_wallet_details`, `native_transfer`.
- Type `exit` at the `Prompt>` REPL to quit.
- If wallet initialization fails with `401`/`Unauthorized`, verify CDP API credentials in the Coinbase Developer Platform dashboard.
