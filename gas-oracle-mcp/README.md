# AgentWire MCP

`gas-oracle-mcp/` is the legacy folder path. The actual service/package name is AgentWire / `agentwire-mcp`.

**Webhook inbox + web fetch + multi-chain gas oracle for autonomous AI agents.** Agents pay USDC via [x402](https://x402.org) to use infrastructure they cannot host themselves.

## Why agents pay for this repeatedly

| Problem | AgentWire solution |
|---|---|
| Agents can't receive inbound HTTP (Stripe, GitHub, human replies) | **Webhook inbox** — POST events in, `drain_inbox` pulls them into the agent loop |
| Agents can't browse the web reliably | **`fetch_url`** — returns clean text + SHA-256 content hash from any public URL |
| Agents need reliable gas fees across L2s | **`get_gas_oracle`** — EIP-1559 + USD estimates, multi-chain |

This is real infrastructure, not a demo. Every agent loop that waits for external input will call `drain_inbox` over and over.

`GET /` is an x402 v2 paid discovery endpoint for CDP Bazaar indexing. Unpaid requests return `402 Payment Required` with the base64 `PAYMENT-REQUIRED` header and Bazaar metadata.

## Tools

| Tool | Price | What it does |
|---|---|---|
| `create_inbox` | **free** | Creates `{ inboxId, secret, webhookUrl }` |
| `drain_inbox` | $0.005 | Pull all pending webhook events and clear the queue |
| `peek_inbox` | $0.002 | Read events without clearing |
| `fetch_url` | $0.012 | Fetch a public URL → agent-readable text + content hash |
| `relay_post` | $0.015 | POST JSON to a public URL and return the response |
| `get_gas_oracle` | $0.002 | Multi-chain EIP-1559 gas + USD cost estimates |
| `get_gas_oracle_batch` | $0.002 | Batch gas oracle (up to 6 chains) |
| `estimate_tx_cost` | $0.002 | Custom gasLimit cost estimate |
| `list_gas_chains` | $0.002 | List supported gas-oracle chains |
| `ping` | **free** | Health check (includes storage/redis status) |

## Multi-chain gas oracle (x402 v2 + Bazaar)

Paid MCP tools (all use `PRICE_GAS_ORACLE`, default `$0.002`):

| Tool | Purpose |
|------|---------|
| `get_gas_oracle` | EIP-1559 fees + USD estimates for one chain |
| `get_gas_oracle_batch` | Up to 6 chains in parallel |
| `estimate_tx_cost` | Custom gasLimit cost estimate |
| `list_gas_chains` | Supported chain catalog |

Chains: `ethereum`, `base`, `arbitrum`, `optimism`, `polygon`, `base-sepolia`.

Each tool is registered with `@x402/extensions/bazaar` `declareDiscoveryExtension` (MCP input type, JSON Schema Draft 2020-12, output examples) so CDP Facilitator / Agentic.Market can index them after settlement.

### Production Railway services

AgentWire production runs as a multi-service Railway project. See root README and `docs/RAILWAY-DEPLOY.md`.

`GET /` and `/.well-known/x402` remain the discovery surface; MCP tools are cataloged via Bazaar MCP discovery metadata on each paid tool's 402 challenge.
