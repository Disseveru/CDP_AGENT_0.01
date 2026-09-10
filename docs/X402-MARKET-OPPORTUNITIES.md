# x402 / Agentic Market — opportunity notes (updated 2026-09-10)

Snapshot for sellers listing on Agentic.Market and similar x402 directories.

## Protocol state

- HTTP-native payments via 402 + `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` (v2).
- Neutral home: Linux Foundation **x402 Foundation** (operational 14 July 2026). Premier members include Visa, Mastercard, Stripe, Adyen, Amex, AWS, Google, Coinbase, Circle, Cloudflare, Shopify, Ripple, Solana Foundation, Stellar.
- Public dashboard (x402.org / agenteconomy.to, Sep 2026): ~186M cumulative txs and ~$42M settled across 12 chains. Independent analysts warn a large share can be wash/bridge/test volume — treat counts as an upper bound.
- Dominant rails: USDC on Base (Coinbase CDP facilitator) and USDC on Solana. Average *organic* payment is still cents.
- Adjacent protocols: Google AP2 (spend authority), Stripe/Tempo MPP (session/streaming), ACP (consumer checkout). They are layers, not drop-in replacements.

## Agentic.Market (Sep 10 2026 snapshot)

Coinbase storefront. Live homepage showed ~$28.5k 1D tape and ~$54.3M all-time protocol volume, ~30M txs / 20k buyers / 16k sellers in 30D. Featured bundles: IPO Analysis, Morning Briefing, Market Research, Talent Market Scanner. Leaderboard names: Exa, Claude, Tripadvisor, The Graph, ChatGPT, Deepgram, CoinMarketCap, Alchemy, Parallel, Perplexity.

New-ish / high-visibility sellers vs April launch set: Parallel, The Graph, Tripadvisor, Otto AI, StableUpload, Amadeus, FlightAware, Wolfram|Alpha, Messari, Browserbase, AgentMail, Allium, Tavily, DeepSeek.

Neutral crawler agent402.tools: 3k+ distinct payees, 100k advertised tools — quality is a power-law. Organic earners that clear ~$100/30d are still tens, not thousands.

## What already sells (crowded)

Inference routers, scrapers, generic price feeds, image gen, travel/search wrappers, heuristic wallet-risk scores. Another generic LLM proxy is a race to $0.0005/call.

## Whitespace that agents repurchase

1. Pre-trade chain economics. **Shipped.**
2. Spend policy / budget math. **Shipped.**
3. Settlement verification. **Shipped.**
4. Inbound webhook inboxes. **Shipped.**
5. HITL CAPTCHA. **Shipped.**
6. Facilitator + seller 402 probe. **Shipped.**
7. Token/allowlist screens. **Shipped in 1.9.0** (`screen_token_allowlist`).
8. Multi-facilitator failover. **Shipped in 1.9.0** (`pick_facilitator_failover`).
9. Signed delivery receipts. **Shipped in 1.9.0** (`issue_delivery_receipt`).
10. Combined A2A safety bundle. **Shipped in 1.9.0** (`a2a_commerce_bundle`).
11. Still open: SLA escrow / holdbacks, on-chain attestation of receipts, Solana-native allowlists.

## Honest revenue note

Headline x402 volume is mostly sub-dollar API calls. New sellers should not treat 186M txs as their forecast. Tools that stop wasted settlement (gas, budget, verify, probe, allowlist, failover, HITL) are the ones agents repurchase.

## AgentWire SKUs

Existing: `quote_gas`, `quote_gas_bundle`, `estimate_tx_cost`, `get_balance`, `get_tx_status`, `plan_agent_spend`, `verify_settlement`, `cheapest_chain`, `probe_x402_endpoint`, `search_agentic_market`, `score_x402_seller`, `preflight_pay_session`.

New 1.9.0: `screen_token_allowlist` ($0.004), `pick_facilitator_failover` ($0.004), `issue_delivery_receipt` ($0.005), `a2a_commerce_bundle` ($0.015).
