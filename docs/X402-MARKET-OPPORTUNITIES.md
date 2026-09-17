# x402 / Agentic Market — opportunity notes (updated 2026-09-17)

Snapshot for sellers listing on Agentic.Market and similar x402 directories.

## Protocol state

- HTTP-native payments via 402 + `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` (v2).
- Neutral home: Linux Foundation **x402 Foundation** (operational 14 July 2026). Premier members include Visa, Mastercard, Stripe, Adyen, Amex, AWS, Google, Coinbase, Circle, Cloudflare, Shopify, Ripple, Solana Foundation, Stellar.
- Public dashboard ranges widely by tracker. As of 17 Sep 2026, agenteconomy.to counted ~188M cumulative settlements / ~$42M across 12 chains. Independent analysts (TRM, Bitquery, x402stats) warn most headline volume is not agentic commerce — treat counts as an upper bound.
- Dominant rail: USDC on Base (Coinbase CDP facilitator) and USDC on Solana. Average payment is still cents, not dollars.
- Adjacent protocols: Google AP2 (spend authority), Stripe/Tempo MPP (session/streaming), ACP (consumer checkout). They are layers, not drop-in replacements.

## Agentic.Market (live 17 Sep 2026)

Coinbase storefront for discovering x402 services. Catalog still clusters around inference, data, search, travel, infra, and social wrappers. Live API (`GET https://api.agentic.market/v1/services`) currently surfaces first-party and gateway listings such as Exa, Claude/Venice/Bankr/BlockRun, Tripadvisor (PaySponge), The Graph (`isNew: true`), ChatGPT gateways, Deepgram, CoinMarketCap. Quality metrics on Exa search show thousands of 30-day calls; most wrappers show single-digit organic payers.

Neutral crawlers such as agent402.tools list thousands of payees; quality varies wildly. Organic seller count that actually earns is far smaller than raw wallet counts (x402stats: ~78 organic businesses on $1.2M real 30d volume in early September).

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
14. Still open: on-chain SLA escrow contracts, token metadata/honeypot bytecode analysis, facilitator-authenticated settle polling as a paid SKU.

## Honest revenue note

Headline x402 volume is mostly sub-dollar API calls. New sellers should not treat 188M txs as their forecast. Tools that stop wasted settlement (gas, budget, verify, screen, receipt, failover, token hygiene) are the ones agents repurchase.

## AgentWire SKUs (1.10.0)

`quote_gas`, `quote_gas_bundle`, `estimate_tx_cost`, `get_balance`, `get_tx_status`, `plan_agent_spend`, `verify_settlement`, `cheapest_chain`, `probe_x402_endpoint`, `screen_payee`, `screen_token`, `quote_sla_escrow`, `probe_facilitator_bundle`, `bundle_agent_quote`, `issue_delivery_receipt`, `verify_delivery_receipt`, `facilitator_failover`.
