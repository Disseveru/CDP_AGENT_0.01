# AgentWire MCP

`gas-oracle-mcp/` is the legacy folder path. The actual service/package name is AgentWire / `agentwire-mcp`.

**Webhook inbox + web fetch for autonomous AI agents.** Agents pay USDC via [x402](https://x402.org) to use infrastructure they cannot host themselves.

## Why agents pay for this repeatedly

| Problem | AgentWire solution |
|---|---|
| Agents can't receive inbound HTTP (Stripe, GitHub, human replies) | **Webhook inbox** — POST events in, `drain_inbox` pulls them into the agent loop |
| Agents can't browse the web reliably | **`fetch_url`** — returns clean text + SHA-256 content hash from any public URL |
| Agents can't make outbound API calls | **`relay_post`** — relays POST/PUT/PATCH to public APIs with SSRF protection |
| Agents need to crawl or research link graphs | **`extract_links`** — returns anchor links from any public page |

This is real infrastructure, not a demo. Every agent loop that waits for external input will call `drain_inbox` over and over.

`GET /` is an x402 v2 paid discovery endpoint for CDP Bazaar indexing. Unpaid requests return `402 Payment Required` with the base64 `PAYMENT-REQUIRED` header and Bazaar metadata.

## Tools

| Tool | Price | What it does |
|---|---|---|
| `create_inbox` | **free** | Creates `{ inboxId, secret, webhookUrl }` |
| `drain_inbox` | $0.005 | Pull all pending webhook events and clear the queue |
| `peek_inbox` | $0.002 | Read events without clearing |
| `inbox_stats` | $0.001 | Count pending events without reading payloads |
| `fetch_url` | $0.012 | Fetch a public URL → agent-readable text + content hash |
| `extract_links` | $0.008 | Extract anchor links from a public page |
| `relay_post` | $0.015 | Relay outbound POST/PUT/PATCH to a public API |
| `ping` | **free** | Health check |

## Deploy in 10 minutes (no coding — works from your phone)

### 1. Get CDP keys (one time)

1. Go to [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com) on your phone browser
2. Create an **API key** → copy **API key ID** + **secret**
3. Go to **Wallet Secret** → create and copy it

### 2. Deploy on Railway (free tier works for testing)

1. Go to [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo**
2. Select this repo (no Root Directory change needed — `/railway.toml` at the repo root builds `gas-oracle-mcp/`, but the deployed service itself is AgentWire)
3. Open **Variables** and add:
   - `CDP_API_KEY` (or `CDP_API_KEY_ID`) for the API key ID
   - `CDP_PRIVATE_KEY` (or `CDP_API_KEY_SECRET`) for the API key secret / PEM
   - `CDP_WALLET_SECRET`
   - Optional: `PAY_TO_ADDRESS=0x...` to reuse an existing payout wallet and skip CDP wallet creation on boot
   - `NETWORK` = `base` (real money, Bazaar-discoverable) or `base-sepolia` (testnet)
   - Facilitator defaults to the CDP endpoint (`https://api.cdp.coinbase.com/platform/v2/x402`) per the [sellers quickstart](https://docs.cdp.coinbase.com/x402/quickstart-for-sellers). Override with `FACILITATOR_URL=https://x402.org/facilitator` for signup-free testnet testing.
4. **Networking** → **Generate Domain**
5. Deploy. Visit `https://YOUR-DOMAIN.up.railway.app/health` — should show `{"status":"ok"}`. Then visit `/ready` to confirm CDP/x402 initialization completed.

Your public URLs:
- MCP endpoint: `https://YOUR-DOMAIN.up.railway.app/mcp`
- Cursor SSE endpoint: `https://YOUR-DOMAIN.up.railway.app/sse`
- Webhooks: `https://YOUR-DOMAIN.up.railway.app/hooks/{inboxId}`

### 4. Connect Cursor IDE (remote MCP over SSE)

From the repo root:

```bash
npm run setup:cursor-mcp -- https://YOUR-DOMAIN.up.railway.app
```

Copy the printed `MCP_API_KEY` into **Railway → Variables**, redeploy, then verify:

```bash
npm run verify:cursor-mcp
```

Restart Cursor, open **Settings → MCP**, and enable **gas-oracle-mcp**.

If the CDP facilitator fails to initialize on Railway, AgentWire still serves free tools (`ping`, `create_inbox`) over SSE while paid x402 tools remain unavailable until credentials are fixed.

### 3. Go live on mainnet (real USDC)

Keep `NETWORK=base` in Railway variables and redeploy. After the first paid call settles through the CDP facilitator, your service auto-lists in the **x402 Bazaar** where buyer agents discover it.

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

Cloud secret managers often inject `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`; AgentWire accepts those aliases too.

## Revenue

Every paid tool call settles USDC to your CDP wallet (`payTo` address printed on boot). On testnet it's fake USDC; on mainnet it's real.
