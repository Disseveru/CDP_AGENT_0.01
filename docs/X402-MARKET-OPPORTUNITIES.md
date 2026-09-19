# x402 / Agentic Market — opportunity notes (updated 2026-09-19)

Snapshot for sellers listing on Agentic.Market and similar x402 directories.

## Protocol state

- HTTP-native payments via 402 + `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` (v2).
- Neutral home: Linux Foundation **x402 Foundation** (operational 14 July 2026). Premier members include Visa, Mastercard, Stripe, Adyen, Amex, AWS, Google, Coinbase, Circle, Cloudflare, Shopify, Ripple, Solana Foundation, Stellar.
- Public dashboard ranges widely by tracker. As of 19 Sep 2026, agenteconomy.to counted ~188M cumulative settlements / ~$42M across 12 chains. Independent analysts (TRM, Bitquery, x402stats) warn most headline volume is not agentic commerce — treat counts as an upper bound.
- Dominant rail: USDC on Base (Coinbase CDP facilitator) and USDC on Solana. Average payment is still cents, not dollars.
- Adjacent protocols: Google AP2 (spend authority), Stripe/Tempo MPP (session/streaming), ACP (consumer checkout). They are layers, not drop-in replacements.
- 17 Sep 2026: Coinbase facilitator on Solana added the `upto` scheme, ~75ms verify, and automatic pending-settle retry in canonical SDKs.

## Agentic.Market (live 19 Sep 2026)

Coinbase storefront for discovering x402 services. Catalog still clusters around inference, data, search, travel, infra, and social wrappers. Featured categories at launch: Inference (OpenAI, Venice, ElevenLabs), Data (CoinGecko, Nansen, Bloomberg, Google Maps), Search (Firecrawl, Exa, Browserbase), Social (LinkedIn, X, AgentMail), Infrastructure (Alchemy, QuickNode, AWS Lambda), Trading (Bankr, Coinbase Advanced Trade). Quality is top-heavy: a few search/data endpoints show real repeat buyers; most wrappers are dust.

Neutral crawlers list thousands of payees; organic seller count that actually earns is far smaller than raw wallet counts (x402stats: ~78 organic businesses on $1.2M real 30d volume in early September).

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
14. Token metadata / selector hygiene (`analyze_token_risk`). **Shipped 1.11.0.**
15. Facilitator settle poll classifier (`poll_facilitator_settle`). **Shipped 1.11.0.**
16. On-chain SLA parameter plan (`plan_onchain_sla_escrow`) — plan only, no unaudited deploy. **Shipped 1.11.0.**
17. Still open: audited on-chain escrow implementation, full bytecode/honeypot simulation, facilitator-authenticated CDP JWT settle as a managed sidecar.

## Honest revenue note

Headline x402 volume is mostly sub-dollar API calls. New sellers should not treat 188M txs as their forecast. Tools that stop wasted settlement (gas, budget, verify, screen, receipt, failover, token hygiene, settle-state) are the ones agents repurchase.

## AgentWire SKUs (1.11.0)

`quote_gas`, `quote_gas_bundle`, `estimate_tx_cost`, `get_balance`, `get_tx_status`, `plan_agent_spend`, `verify_settlement`, `cheapest_chain`, `probe_x402_endpoint`, `screen_payee`, `screen_token`, `quote_sla_escrow`, `probe_facilitator_bundle`, `bundle_agent_quote`, `issue_delivery_receipt`, `verify_delivery_receipt`, `facilitator_failover`, `analyze_token_risk`, `poll_facilitator_settle`, `plan_onchain_sla_escrow`.
