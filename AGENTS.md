# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

Node.js CLI agent using **Coinbase CDP AgentKit** (`@coinbase/agentkit`), **LangChain** (`@coinbase/agentkit-langchain`), and **Google Gemini** (`@langchain/google-genai`) on **Base Sepolia**. Entry point: `index.js`.

### Required environment variables

| Variable | Purpose |
|---|---|
| `CDP_API_KEY` | CDP API key ID |
| `CDP_PRIVATE_KEY` | CDP API key private key (EC PEM; may be injected as a single line) |
| `GEMINI_API_KEY` | Google Gemini API key |

`CDP_WALLET_SECRET` is optional for this legacy wallet flow but may be required for newer CDP v2 wallet providers.

### Commands

| Task | Command |
|---|---|
| Install dependencies | `npm install` |
| Start interactive agent REPL | `npm start` or `node index.js` |

### Runtime notes

- Wallet state persists to `wallet_data.txt` (gitignored). Delete this file to force a new wallet on the next run.
- The app uses `LegacyCdpWalletProvider` (the current name for the classic `CdpWalletProvider` + `wallet_data.txt` pattern) on `base-sepolia`.
- Focused AgentKit tools: `deploy_token`, `mint` (ERC-721; referred to as mint_token in prompts), and `get_wallet_details`.
- Type `exit` at the `Prompt>` REPL to quit.
- If wallet initialization fails with `401`/`Unauthorized`, verify CDP API credentials in the Coinbase Developer Platform dashboard.
