# x402 / Agentic Market — opportunity notes (updated 2026-09-20)

Snapshot for sellers listing on Agentic.Market and similar x402 directories.

## Protocol state

- HTTP-native payments via 402 + `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` (v2).
- Neutral home: Linux Foundation **x402 Foundation** (operational 14 July 2026). Premier members include Visa, Mastercard, Stripe, Adyen, Amex, AWS, Google, Coinbase, Circle, Cloudflare, Shopify, Ripple, Solana Foundation, Stellar.
- Public dashboard ranges widely by tracker. As of 20 Sep 2026, agenteconomy.to counted ~188M cumulative settlements / ~$42M across 12 chains. Independent analysts (TRM, Bitquery, x402stats) warn most headline volume is not agentic commerce — treat counts as an upper bound.
- Dominant rail: USDC on Base (Coinbase CDP facilitator) and USDC on Solana. Average payment is still cents, not dollars.
- Adjacent protocols: Google AP2 (spend authority), Stripe/Tempo MPP (session/streaming), ACP (consumer checkout). They are layers, not drop-in replacements.
- Sep 2026 facilitator updates: Solana `upto` scheme live, verify latency ~75ms on Coinbase Solana facilitator.

## Agentic.Market (live 20 Sep 2026)

Coinbase storefront for discovering x402 services. The public homepage often shows $0.00 1D volume while the Bazaar/index crawlers list thousands of payees. Neutral index agent402.tools: ~3.3k distinct payees, ~4.3k endpoints, ~100k advertised tools, 12 chains.

High-traffic indexed hosts (not all organic): BlockRun, AX1 Console, OneShot, stableenrich, x402.agentutility.ai, JarvisClaw, Nansen, Exa, Glassnode, Bitrefill, 0x agent API. Quality varies; many listings are dead or give the product away on HTTP 200.

Organic seller count that actually earns is far smaller than raw wallet counts (x402stats early September: ~78 organic businesses on $1.2M real 30d volume).

## What already sells (crowded)

Inference routers, scrapers, generic price feeds, image gen, travel/search wrappers, heuristic wallet-risk scores. Another generic LLM proxy is a race to $0.0005/call.

## Whitespace that agents repurchase

1. Pre-trade chain economics. **Shipped.**
2. Spend policy / budget math. **Shipped.**
3. Settlement verification. **Shipped.**
4. Inbound webhook inboxes. **Shipped.**
5. HITL CAPTCHA. **Shipped.**
6. Facilitator + seller 402 probe. **Shipped.**
7. Payee allowlist/denylist + price cap (`screen_payee`). **Shipped 1.9.0.**
8. Multi-SKU session quote (`bundle_agent_quote`). **Shipped 1.9.0.**
9. Signed delivery receipts (`issue_delivery_receipt` / `verify_delivery_receipt`). **Shipped 1.9.0.**
10. Facilitator failover pick (`facilitator_failover`). **Shipped 1.9.0.**
11. ERC-20 settlement allowlist (`screen_token`). **Shipped 1.10.0.**
12. Off-chain SLA hold/penalty quote (`quote_sla_escrow`). **Shipped 1.10.0.**
13. Live multi-facilitator HTTPS probe (`probe_facilitator_bundle`). **Shipped 1.10.0.**
14. Token bytecode hygiene (`analyze_token_bytecode`). **Shipped 1.11.0.**
15. Facilitator settle polling (`poll_facilitator_settle`). **Shipped 1.11.0.**
16. Still open: on-chain SLA escrow *contracts* (quote-only remains; do not ship a custodial escrow that holds buyer funds in this service).

## Honest revenue note

Headline x402 volume is mostly sub-dollar API calls. New sellers should not treat 188M txs as their forecast. Tools that stop wasted settlement (gas, budget, verify, screen, receipt, failover, token hygiene, settle poll) are the ones agents repurchase.

Recommended bundle to list on Agentic.Market: `screen_payee` + `screen_token` + `analyze_token_bytecode` + `poll_facilitator_settle` + `quote_gas` at $0.004–$0.012 each. That is pre-trade hygiene agents must buy on every new seller they meet.

## AgentWire SKUs (1.11.0)

`quote_gas`, `quote_gas_bundle`, `estimate_tx_cost`, `get_balance`, `get_tx_status`, `plan_agent_spend`, `verify_settlement`, `cheapest_chain`, `probe_x402_endpoint`, `screen_payee`, `screen_token`, `quote_sla_escrow`, `probe_facilitator_bundle`, `bundle_agent_quote`, `issue_delivery_receipt`, `verify_delivery_receipt`, `facilitator_failover`, `analyze_token_bytecode`, `poll_facilitator_settle`.
