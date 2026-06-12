# CDP AgentKit + Gemini CLI

Two projects in one repo, both built on **Coinbase CDP AgentKit** on **Base** (Sepolia by default):

| Path | What it is |
|---|---|
| `index.js` (root) | Interactive Node.js CLI agent powered by LangChain + Google Gemini. Mints NFTs, sends ETH, checks wallet details. Defaults to a CDP Smart Wallet with the Base Paymaster so transactions are gasless. |
| `gas-oracle-mcp/` | Standalone TypeScript MCP server (**AgentWire**). The folder keeps a legacy name, but the deployed service/package is AgentWire / `agentwire-mcp`. It sells webhook inbox relay + web fetch to autonomous agents for USDC micro-payments via the [x402](https://x402.org) protocol. |

Both projects share the same set of Coinbase CDP credentials.

---

## Prerequisites

- Node.js `>= 20`
- A Coinbase Developer Platform account ([portal.cdp.coinbase.com](https://portal.cdp.coinbase.com)) with an API key and Wallet Secret
- A Google AI Studio API key for Gemini ([aistudio.google.com](https://aistudio.google.com)) — root CLI only

---

## Environment variables

Create a `.env` in the project root (gitignored). The root agent and the subproject read the same CDP credentials.

### Required

| Variable | Used by | Purpose |
|---|---|---|
| `CDP_API_KEY` | both | CDP API key ID (UUID-style string) |
| `CDP_PRIVATE_KEY` | both | CDP API key secret (PEM, may be a single line — `\n` escapes are fine) |
| `CDP_WALLET_SECRET` | both | CDP Wallet Secret for v2 server-wallet operations |
| `GEMINI_API_KEY` | root CLI | Google Gemini API key |

> Do **not** use deprecated names like `CDP_API_KEY_NAME` or `CDP_API_PRIVATEKEY`.

### Optional (root CLI)

| Variable | Default | Purpose |
|---|---|---|
| `BASE_PAYMASTER` | `1` (on) | Set to `0`/`false` to disable the CDP Smart Wallet + Base Paymaster path |
| `USE_EOA_WALLET` | `0` (off) | Set to `1`/`true` to force a standard CDP server wallet instead of a Smart Wallet |
| `PAYMASTER_URL` | auto-resolved | Override the CDP Paymaster & Bundler endpoint |
| `NETWORK_ID` | `base-sepolia` | Use `base-mainnet` for production |
| `RPC_URL` | network default | Override the public Base RPC |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Override the Gemini model name |

### Optional (`gas-oracle-mcp/`)

See `gas-oracle-mcp/.env.example` for the annotated list: `NETWORK`, `PAY_TO_ADDRESS`, `FACILITATOR_URL`, `PRICE_DRAIN_INBOX`, `PRICE_PEEK_INBOX`, `PRICE_FETCH_URL`, `PORT`, `PUBLIC_URL`.

---

## Root CLI agent

### Install

```bash
npm install
```

### Run

```bash
npm start
# or: node index.js
```

You'll get an interactive `Prompt>` REPL. Type `exit` to quit.

By default it boots a **CDP Smart Wallet** with the **Base Paymaster** for sponsored (gasless) transactions on Base Sepolia. To use a regular CDP v2 EOA wallet instead:

```bash
USE_EOA_WALLET=1 npm start
# or
BASE_PAYMASTER=0 npm start
```

The wallet is persisted to `wallet_data.txt` (gitignored, `0600` permissions). Delete it to force a brand-new wallet on the next run.

Available tools depend on the wallet mode:

- **Smart Wallet** (default): `mint`, `get_wallet_details`, `native_transfer`
- **CDP v2 EOA**: `mint`, `get_wallet_details`, `request_faucet_funds`
- **Legacy**: also adds `deploy_token`

If wallet init fails with `401`/`Unauthorized`, double-check your CDP credentials in the CDP Dashboard.

---

## AgentWire (`gas-oracle-mcp/`) — paid MCP server

Sells `drain_inbox` ($0.005), `peek_inbox` ($0.002), and `fetch_url` ($0.012) to autonomous agents over MCP Streamable HTTP, with USDC micro-payments settled via the x402 protocol. Free tools: `create_inbox`, `ping`. Webhooks arrive at `POST /hooks/{inboxId}`.

### Install and run

```bash
cd gas-oracle-mcp
npm install --legacy-peer-deps     # plain `npm install` may hang on the AgentKit dep graph
cp .env.example .env               # fill in your CDP keys
npm start                          # builds and runs dist/server.js
```

The server prints your **revenue wallet address** (`payTo`) on boot — every paid call settles to that address.

### Test it

```bash
npm run smoke-test     # no payment; verifies tool listing + x402 challenge + Bazaar metadata
npm run paid-test      # full E2E: auto-funds a local buyer wallet via the CDP USDC faucet
                       # and settles two real testnet USDC payments
```

### Go live on mainnet

Change `NETWORK=base` in `.env` and restart. Payments will then settle in real USDC via the CDP facilitator, and the service is auto-indexed in the x402 Bazaar after the first sale.

### Deploy on Railway

A [Railway](https://railway.com) config is included (`gas-oracle-mcp/railway.toml`). Connect this GitHub repo, set the service **Root Directory** to `gas-oracle-mcp`, and name the Railway service `AgentWire` if you want the dashboard label to match the app name. Generate a public domain and add your CDP env vars in the Railway dashboard. `PUBLIC_URL` is optional on Railway — the server auto-detects `RAILWAY_PUBLIC_DOMAIN`.

See `gas-oracle-mcp/README.md` for step-by-step Railway setup and buyer-agent integration details.

### Fix deployments from Cursor

This repo includes [Railway MCP](https://docs.railway.com/ai/mcp-server#cursor) in `.cursor/mcp.json` so Cursor can manage Railway directly (logs, redeploys, env vars, and deployment debugging).

1. **Restart Cursor** after pulling so it picks up `.cursor/mcp.json`.
2. Open **Cursor Settings → MCP** and confirm `railway` and/or `railway-remote` are enabled.
3. **Authenticate:**
   - **`railway-remote`** (easiest): when Cursor connects, sign in to Railway in the browser (OAuth). Use this to ask things like *"Why is my backend crashing on deploy?"* — it can call Railway's `railway-agent` tool.
   - **`railway`** (local CLI): install the [Railway CLI](https://docs.railway.com/develop/cli), then run `railway login`. Gives direct access to logs, variables, deploys, and more.

One-time CLI setup (optional, for the local server):

```bash
bash <(curl -fsSL https://railway.com/install.sh)
railway login
railway mcp install --agent cursor   # merges into ~/.cursor/mcp.json if you prefer user-level config
```

---

## Repo layout

```
.
├── index.js              Root CLI agent (CommonJS, Node 20+)
├── package.json
├── gas-oracle-mcp/       Paid MCP server subproject (TypeScript, ESM)
│   ├── railway.toml      Railway deploy config
│   ├── src/
│   ├── scripts/
│   └── README.md
├── .cursor/
│   └── mcp.json          Railway MCP servers for Cursor
└── AGENTS.md             Agent / contributor instructions
```
