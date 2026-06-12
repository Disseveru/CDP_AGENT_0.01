# AgentWire MCP

**Webhook inbox + web fetch for autonomous AI agents.** Agents pay USDC via [x402](https://x402.org) to use infrastructure they cannot host themselves.

## Why agents pay for this repeatedly

| Problem | AgentWire solution |
|---|---|
| Agents can't receive inbound HTTP (Stripe, GitHub, human replies) | **Webhook inbox** — POST events in, `drain_inbox` pulls them into the agent loop |
| Agents can't browse the web reliably | **`fetch_url`** — returns clean text + SHA-256 content hash from any public URL |

This is real infrastructure, not a demo. Every agent loop that waits for external input will call `drain_inbox` over and over.

## Tools

| Tool | Price | What it does |
|---|---|---|
| `create_inbox` | **free** | Creates `{ inboxId, secret, webhookUrl }` |
| `drain_inbox` | $0.005 | Pull all pending webhook events and clear the queue |
| `peek_inbox` | $0.002 | Read events without clearing |
| `fetch_url` | $0.012 | Fetch a public URL → agent-readable text + content hash |
| `ping` | **free** | Health check |

## Deploy in 10 minutes (no coding — works from your phone)

### 1. Get CDP keys (one time)

1. Go to [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com) on your phone browser
2. Create an **API key** → copy **API key ID** + **secret**
3. Go to **Wallet Secret** → create and copy it

### 2. Deploy on Railway (free tier works for testing)

1. Go to [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo**
2. Select this repo
3. Open service **Settings**:
   - **Root Directory**: `gas-oracle-mcp`
   - **Config file**: `/gas-oracle-mcp/railway.toml`
4. Open **Variables** and add:
   - `CDP_API_KEY` (API key ID)
   - `CDP_PRIVATE_KEY` (API key secret / PEM)
   - `CDP_WALLET_SECRET`
   - `NETWORK` = `base-sepolia` (testnet) or `base` (real money)
5. **Networking** → **Generate Domain**
6. Deploy. Visit `https://YOUR-DOMAIN.up.railway.app/health` — should show `{"status":"ok"}`

Your public URLs:
- MCP endpoint: `https://YOUR-DOMAIN.up.railway.app/mcp`
- Webhooks: `https://YOUR-DOMAIN.up.railway.app/hooks/{inboxId}`

### 3. Go live on mainnet (real USDC)

Change `NETWORK=base` in Railway variables and redeploy. After the first paid call, your service auto-lists in the **x402 Bazaar** where buyer agents discover it.

## How it works (agent workflow)

```
1. Agent calls create_inbox (free)
   → gets webhookUrl like https://your-app.up.railway.app/hooks/abc123

2. You configure Stripe/GitHub/a form to POST to that URL

3. Agent loop calls drain_inbox (paid, $0.005)
   → receives all pending events as JSON

4. Agent calls fetch_url (paid, $0.012) when it needs web content
```

## Test locally (if you have a laptop later)

```bash
cd gas-oracle-mcp
npm install --legacy-peer-deps
cp .env.example .env   # paste your 3 CDP keys
npm start
npm run smoke-test     # free
npm run paid-test      # settles real testnet USDC
```

## Revenue

Every paid tool call settles USDC to your CDP wallet (`payTo` address printed on boot). On testnet it's fake USDC; on mainnet it's real.
