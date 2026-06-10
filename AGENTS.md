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

Do not use deprecated names like `CDP_API_KEY_NAME` or `CDP_API_PRIVATEKEY`.

### Commands

| Task | Command |
|---|---|
| Install dependencies | `npm install` |
| Start interactive agent REPL | `npm start` or `node index.js` |

### Runtime notes

- Wallet state persists to `wallet_data.txt` (gitignored). Delete this file to force a new wallet on the next run.
- The app prefers `CdpEvmWalletProvider` (CDP v2) when `CDP_WALLET_SECRET` is set, and falls back to `LegacyCdpWalletProvider` for `deploy_token` support on `base-sepolia`.
- Focused AgentKit tools: `deploy_token`, `mint` (ERC-721; referred to as mint_token in prompts), and `get_wallet_details`.
- Type `exit` at the `Prompt>` REPL to quit.
- If wallet initialization fails with `401`/`Unauthorized`, verify CDP API credentials in the Coinbase Developer Platform dashboard.
