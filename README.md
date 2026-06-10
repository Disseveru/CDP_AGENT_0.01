# CDP AgentKit + Gemini CLI

Coinbase CDP AgentKit agent on Base Sepolia with LangChain and Google Gemini.

## Setup

```bash
npm install
```

Set environment variables:

- `CDP_API_KEY` or `CDP_API_KEY_ID`
- `CDP_PRIVATE_KEY` or `CDP_API_KEY_SECRET`
- `GEMINI_API_KEY`

## Run

```bash
npm start
```

The agent opens an interactive REPL. Type `exit` to quit. Wallet state is persisted in `wallet_data.txt`.