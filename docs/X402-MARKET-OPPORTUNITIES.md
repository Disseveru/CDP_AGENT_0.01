# x402 / Agentic Market — opportunity notes (updated 2026-09-06)

Snapshot for sellers listing on Agentic.Market and similar x402 directories.

## Protocol state

- HTTP-native payments via 402 + `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` (v2).
- Neutral home: Linux Foundation **x402 Foundation** (operational 14 July 2026). Premier members include Visa, Mastercard, Stripe, Adyen, Amex, AWS, Google, Coinbase, Circle, Cloudflare, Shopify, Ripple, Solana Foundation, Stellar.
- Public dashboard (x402.org, late Aug 2026): ~75M txs / ~$24M / ~94k buyers / ~22k sellers in 30 days. Independent analysts warn a large share can be wash/test volume — treat counts as an upper bound.
- Cumulative public trackers (Sep 2026): ~184M settled payments / ~$42M USD, 12+ chains, 18 facilitators. Base still leads cumulative count; Solana periodically leads weekly USDC flow.
- Dominant rail: USDC on Base (Coinbase CDP facilitator) and USDC on Solana. Average payment is still cents, not dollars.
- Adjacent protocols: Google AP2 (spend authority), Stripe/Tempo MPP (session/streaming), ACP (consumer checkout). They are layers, not drop-in replacements.

## Agentic.Market

Coinbase's public storefront (Apr 2026) for discovering x402 services. Launch categories: inference, data, media, search, social, infrastructure, trading. Indexing is automatic when the CDP facilitator sees Bazaar discovery metadata.

The consumer UI often shows sparse/zero 1D volume even when protocol-wide flow is large — discovery and settlement are not the same dataset. Neutral crawlers such as agent402.tools list thousands of payees; quality varies wildly.

Recent high-activity sellers on open indexes (not all listed on Agentic.Market UI): BlockRun inference router, stableenrich, x402.twit.sh, farouter.tech, OneShot Agent API, Exa, Massive market data, Nansen, Alpha Vantage via Locus, Bitrefill, base-gas-x402.

## What already sells (crowded)

Inference routers, scrapers, generic price feeds, image gen, travel/search wrappers, heuristic wallet-risk scores. Another generic LLM proxy is a race to $0.0005/call.

## Whitespace that agents repurchase

1. Pre-trade chain economics. **Shipped.**
2. Spend policy / budget math. **Shipped.**
3. Settlement verification. **Shipped.**
4. Inbound webhook inboxes. **Shipped.**
5. HITL CAPTCHA. **Shipped.**
6. Facilitator + seller 402 probe. **Shipped / catalogued.**
7. **Signed delivery receipts + token allowlist + facilitator failover (1.6.1)** — `issue_delivery_receipt`, `verify_delivery_receipt`, `screen_token_allowlist`, `plan_facilitator_failover`.
8. Still open: SLA escrow (needs a custody partner; do not fake on-chain escrow).

## Honest revenue note

Headline x402 volume is mostly sub-dollar API calls. New sellers should not treat 75M txs as their forecast. Tools that stop wasted settlement (gas, budget, verify, probe, HITL, receipts, token screens) are the ones agents repurchase.

## AgentWire SKUs

`quote_gas`, `quote_gas_bundle`, `estimate_tx_cost`, `get_balance`, `get_tx_status`, `plan_agent_spend`, `verify_settlement`, `cheapest_chain`, `probe_facilitator`, `probe_x402_seller`, `issue_delivery_receipt`, `verify_delivery_receipt`, `screen_token_allowlist`, `plan_facilitator_failover`.
