# x402 / Agentic Market — opportunity notes (updated 2026-09-11)

Snapshot for sellers listing on Agentic.Market and similar x402 directories.

## Protocol state

- HTTP-native payments via 402 + `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` (v2).
- Neutral home: Linux Foundation **x402 Foundation** (operational 14 July 2026). Premier members include Visa, Mastercard, Stripe, Adyen, Amex, AWS, Google, Coinbase, Circle, Cloudflare, Shopify, Ripple, Solana Foundation, Stellar.
- Public trackers as of 11 Sep 2026: ~186.6M cumulative txs and ~$41.7M settled across 12 chains (agenteconomy.to). Independent on-chain audits still warn that headline USD can be dominated by bridges and wash volume — treat counts as an upper bound.
- Dominant rail: USDC on Base (Coinbase CDP facilitator) and USDC on Solana. Average payment is still cents, not dollars.
- Adjacent protocols: Google AP2 (spend authority), Stripe/Tempo MPP (session/streaming), ACP (consumer checkout). They are layers, not drop-in replacements.

## Agentic.Market

Coinbase's public storefront (Apr 2026) for discovering x402 services. Launch categories: inference, data, media, search, social, infrastructure, trading. Indexing is automatic when the CDP facilitator sees Bazaar discovery metadata.

The consumer UI often shows sparse/zero 1D volume even when protocol-wide flow is large — discovery and settlement are not the same dataset. Neutral crawlers such as agent402.tools list thousands of payees; quality varies wildly.

Sellers that actually settle (agent402 7D snapshots): BlockRun, TradeOS, dTelecom STT, StableStudio, StableEnrich, CollectablesPulse, twit.sh, agentutility.ai. New listings without a repurchase loop stay at $0.

## What already sells (crowded)

Inference routers, scrapers, generic price feeds, image gen, travel/search wrappers, heuristic wallet-risk scores. Another generic LLM proxy is a race to $0.0005/call.

## Whitespace that agents repurchase

1. Pre-trade chain economics. **Shipped.**
2. Spend policy / budget math. **Shipped.**
3. Settlement verification. **Shipped.**
4. Inbound webhook inboxes. **Shipped.**
5. HITL CAPTCHA. **Shipped.**
6. Facilitator + seller 402 probe. **Shipped.**
7. Token/allowlist screen before signing. **Shipped in 1.9.0 (`screen_pay_asset`).**
8. Multi-agent cost allocation. **Shipped in 1.9.0 (`allocate_agent_budget`).**
9. Signed / hashed delivery receipts. **Shipped in 1.9.0 (`issue_delivery_receipt`).**
10. Still open: SLA escrow, multi-facilitator failover with automatic retry, on-chain reputation scores.

## Honest revenue note

Headline x402 volume is mostly sub-dollar API calls. New sellers should not treat 186M txs as their forecast. Tools that stop wasted settlement (gas, budget, verify, probe, HITL, asset screen, receipts) are the ones agents repurchase.

Suggested list prices for the new bundle: $0.003 / $0.004 / $0.002. Bundle them as a preflight pack: screen → allocate → pay → receipt → verify.

## AgentWire SKUs

`quote_gas`, `quote_gas_bundle`, `estimate_tx_cost`, `get_balance`, `get_tx_status`, `plan_agent_spend`, `verify_settlement`, `cheapest_chain`, `probe_facilitator`, `probe_x402_seller`, `screen_pay_asset`, `allocate_agent_budget`, `issue_delivery_receipt`.
