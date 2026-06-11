# ChainPulse Gas Oracle

A paid MCP (Model Context Protocol) server that sells real-time cross-chain gas intelligence to autonomous AI agents for USDC micro-payments, using the **x402 payment protocol** and a **Coinbase CDP AgentKit** wallet as its on-chain identity.

Every tool call is paywalled: when a buyer agent calls a tool, the server replies with an x402 `Payment Required` challenge, the buyer's wallet signs an EIP-3009 USDC authorization, the facilitator verifies and settles it on-chain, and only then is the data released. Revenue lands directly in your CDP wallet.

## What it sells

| Tool | Price | What the buyer gets |
|---|---|---|
| `get_gas_snapshot` | $0.001 | Live EIP-1559 gas (max fee + priority fee) and latest block for Base, Ethereum, Arbitrum One, OP Mainnet + live ETH-USD rate |
| `recommend_cheapest_chain` | $0.002 | Chains ranked by estimated USD cost for a transaction type (`transfer`, `erc20_transfer`, `swap`, `nft_mint`) with projected savings |
| `ping` | free | Health check and price list |

## Architecture

- `src/server.ts` - Express + MCP Streamable HTTP endpoint at `/mcp`; wraps each paid tool with the x402 payment wrapper
- `src/wallet.ts` - Coinbase CDP AgentKit wallet (the `payTo` revenue address)
- `src/payments.ts` - x402 resource server, facilitator client, and Bazaar v2 auto-discovery metadata (strictly schema-validated at boot)
- `src/gas.ts` - multi-chain gas engine (viem public RPCs + Coinbase spot price API, 5s cache)

On testnet (`base-sepolia`) payments settle through the free `x402.org` facilitator. On mainnet (`base`) they settle through the **CDP Facilitator**, which also indexes the service into the **x402 Bazaar / Agentic.Market** catalog automatically after the first successful settlement (the x402 v2 payment payload carries `paymentPayload.resource` for every tool, which is what the facilitator uses to catalog it).

## Deployment (zero coding required)

### Step 1 - Get your 3 Coinbase keys

1. Go to [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com) and sign in
2. Create an **API key**: copy the **API key ID** and the **API key secret**
3. Go to **Wallet Secret** in settings and create/copy your **wallet secret**

### Step 2 - Install and configure

From the repository root, run this single command:

```bash
cd gas-oracle-mcp && npm install --legacy-peer-deps && cp .env.example .env
```

Then open `.env` in the editor and paste your 3 keys into `CDP_API_KEY`, `CDP_PRIVATE_KEY`, and `CDP_WALLET_SECRET`. Leave everything else as-is.

### Step 3 - Start the server

```bash
npm start
```

You will see your revenue wallet address printed (`Revenue wallet (payTo): 0x...`). That is where every micro-payment lands.

### Step 4 - Verify it works (still zero coding)

In a second terminal:

```bash
cd gas-oracle-mcp && npm run smoke-test
```

This connects as an agent, lists the tools, calls the free `ping`, and confirms unpaid calls are challenged with a valid x402 envelope and Bazaar discovery metadata.

To prove the full payment loop with real testnet USDC (auto-funded from the CDP faucet):

```bash
npm run paid-test
```

It prints two Basescan links to the settled on-chain payments into your wallet.

### Step 5 - Go live on mainnet

When you are ready to earn real USDC, change one line in `.env`:

```
NETWORK=base
```

Restart with `npm start`. Payments now settle in real USDC via the CDP Facilitator, and after the first sale your service is automatically indexed in the x402 Bazaar where buyer agents discover it.

### Step 6 (optional) - Host it 24/7

Deploy the `gas-oracle-mcp` folder to any Node.js host (Railway, Render, Fly.io). Set the same environment variables from your `.env` in the host's dashboard, plus `PUBLIC_URL=https://your-app-url` so the service card advertises the right endpoint.

## How buyer agents connect

Buyers point any MCP client at `POST /mcp` (Streamable HTTP) and wrap it with an x402 payment client, e.g. `@x402/mcp`'s `wrapMCPClientWithPayment`. See `scripts/paid-client-test.ts` for a complete working buyer implementation.

## Environment variables

See `.env.example` for the full annotated list.
