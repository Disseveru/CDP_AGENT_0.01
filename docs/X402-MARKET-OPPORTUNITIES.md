# x402 / Agentic Market — opportunity notes (updated 2026-09-13)

Snapshot for sellers listing on Agentic.Market and similar x402 directories.

## Protocol state

- HTTP-native payments via 402 + `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` (v2).
- Neutral home: Linux Foundation **x402 Foundation** (operational 14 July 2026). Premier members include Visa, Mastercard, Stripe, Adyen, Amex, AWS, Google, Coinbase, Circle, Cloudflare, Shopify, Ripple, Solana Foundation, Stellar.
- Public dashboard ranges widely by tracker. As of 13 Sep 2026, agenteconomy.to counted ~187M cumulative settlements / ~$42M across 12 chains. Independent analysts (TRM, Bitquery, x402stats) warn most headline volume is not agentic commerce — treat counts as an upper bound.
- Dominant rail: USDC on Base (Coinbase CDP facilitator) and USDC on Solana. Average payment is still cents, not dollars.
- Adjacent protocols: Google AP2 (spend authority), Stripe/Tempo MPP (session/streaming), ACP (consumer checkout). They are layers, not drop-in replacements.

## Agentic.Market (live 13 Sep 2026)

Coinbase storefront for discovering x402 services. Featured/new sellers on the homepage that day included Exa, Claude, Tripadvisor, The Graph, ChatGPT, Deepgram, CoinMarketCap, Alchemy, Parallel, Perplexity, plus bundles such as IPO Analysis, Morning Briefing, Market Research, and Talent Market Scanner. Broader catalog still clusters around inference, data, search, travel, infra, and social wrappers.

Neutral crawlers such as agent402.tools list thousands of payees; quality varies wildly. Organic seller count that actually earns is far smaller than raw wallet counts.

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
11. Still open: SLA escrow on-chain, token allowlist screens against malicious ERC-20s, multi-facilitator live HTTP probe bundled into one paid call.

## Honest revenue note

Headline x402 volume is mostly sub-dollar API calls. New sellers should not treat 187M txs as their forecast. Tools that stop wasted settlement (gas, budget, verify, screen, receipt, failover) are the ones agents repurchase.

## AgentWire SKUs (1.9.0)

`quote_gas`, `quote_gas_bundle`, `estimate_tx_cost`, `get_balance`, `get_tx_status`, `plan_agent_spend`, `verify_settlement`, `cheapest_chain`, `probe_x402_endpoint`, `screen_payee`, `bundle_agent_quote`, `issue_delivery_receipt`, `verify_delivery_receipt`, `facilitator_failover`.
