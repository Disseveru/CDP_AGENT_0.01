# x402 / Agentic Market — opportunity notes (2026-09-03)

Snapshot for sellers listing on Agentic.Market and similar x402 directories.

## Protocol state

- HTTP-native payments via 402 + `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE`.
- Neutral home: Linux Foundation **x402 Foundation** (operational July 2026). Premier members include Visa, Mastercard, Stripe, AWS, Google, Coinbase, Circle, Cloudflare, Shopify, Solana Foundation.
- Spec v2: exact, upto, batch-settlement schemes; EVM + Solana + additional chain packages.
- Public 30-day dashboard figures (x402.org, late Aug 2026): ~75M txs, ~$24M volume, ~94k buyers, ~22k sellers. Independent indexers disagree on organic vs looped volume — treat headline counts as upper bound.
- USDC is the dominant settlement asset. Base and Solana carry most flow; Coinbase CDP facilitator remains the production default for Base USDC sellers.

## What already sells (crowded)

Inference routers, scrapers, generic price feeds, image gen, workflow executors, travel/search wrappers, and heuristic wallet-risk scores. Another generic LLM proxy is a race to $0.0005/call.

## Whitespace that agents repurchase

1. Pre-trade chain economics — live EIP-1559 + USD cost for a gasLimit, plus cheapest-chain rank.
2. Spend policy / budget math — how many paid calls $X USDC buys with a reserve floor.
3. Settlement verification — confirm a hash landed and `to` matches `payTo`.
4. Inbound webhook inboxes — already shipped as AgentWire `drain_inbox`.
5. HITL CAPTCHA — already shipped; still scarce as a paid MCP SKU.

## AgentWire SKUs added in 1.5.0

`quote_gas`, `quote_gas_bundle`, `estimate_tx_cost`, `get_balance`, `get_tx_status`, `plan_agent_spend`, `verify_settlement`, `cheapest_chain`.

## AgentWire SKUs added in 1.6.0

`decode_x402_challenge`, `probe_x402`, `check_usdc_ready`, `inspect_payability`, `wallet_ready_bundle`, `score_payto_lookalike`.

The extra paid-tool definitions are now spread into the main server tool registry, so these SKUs are advertised and callable.
