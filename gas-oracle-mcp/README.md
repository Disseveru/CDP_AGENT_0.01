# ChainPulse Preflight

A paid MCP server that **simulates EVM transactions before agents sign them**. Autonomous agents pay USDC micro-payments via **x402** to dry-run calls against live chain state — avoiding reverts, wasted gas, and bad token transfers.

**Why agents pay repeatedly:** every on-chain action should be preflighted. One failed mainnet transaction can cost far more than $0.01 in gas. Agents call `simulate_transaction` before swaps, mints, and contract calls, and `simulate_erc20_transfer` before every token send.

## What it sells

| Tool | Price | What the buyer gets |
|---|---|---|
| `simulate_transaction` | $0.01 | Dry-run any tx (from, to, calldata, value). Returns `willSucceed`, exact gas estimate, revert reason, balance warnings. |
| `simulate_erc20_transfer` | $0.008 | Dry-run an ERC-20 `transfer()` with balance checks and revert decoding (honeypots, pauses, blacklists). |
| `ping` | free | Health check and price list |

Supported chains: **Base**, **Base Sepolia**, **Ethereum**, **Arbitrum**, **Optimism**.

## Architecture

- `src/server.ts` — Express + MCP Streamable HTTP at `/mcp`; x402 payment wrapper per tool
- `src/preflight.ts` — simulation engine (viem `eth_call`, `estimateGas`, `simulateContract`)
- `src/wallet.ts` — CDP AgentKit revenue wallet (`payTo`)
- `src/payments.ts` — x402 facilitator + Bazaar v2 discovery metadata

On testnet (`base-sepolia`) payments settle via the free `x402.org` facilitator. On mainnet (`base`) they settle via the **CDP Facilitator** and auto-index into the **x402 Bazaar** after the first sale.

## Quick start

```bash
cd gas-oracle-mcp
npm install --legacy-peer-deps
cp .env.example .env    # paste CDP_API_KEY, CDP_PRIVATE_KEY, CDP_WALLET_SECRET
npm start
```

The server prints your **revenue wallet** (`payTo`) on boot.

### Test

```bash
npm run smoke-test     # free: tool listing + 402 challenge + Bazaar metadata
npm run paid-test      # E2E: two real testnet USDC settlements
```

### Go live on mainnet

Set `NETWORK=base` in `.env` and restart. Payments settle in real USDC.

### Deploy on Railway

Set **Root Directory** to `gas-oracle-mcp`, config file to `/gas-oracle-mcp/railway.toml`, add CDP env vars, generate a public domain.

## How buyer agents connect

Point an MCP client at `POST /mcp` and wrap with `@x402/mcp`'s `wrapMCPClientWithPayment`. See `scripts/paid-client-test.ts` for a working buyer.

Typical agent loop:

1. Build unsigned transaction
2. Call `simulate_transaction` → if `willSucceed`, proceed; else adjust params
3. Sign and broadcast only after preflight passes

## Environment variables

See `.env.example` for the full list.
