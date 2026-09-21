# x402 + Agentic Market — Opportunity Brief

**Date:** 2026-09-21  
**Scope:** protocol state, marketplace supply, whitespace for AgentWire (`gas-oracle-mcp`)

This file is documentation only. It does not change runtime tools, prices, or payment wiring.

## Protocol snapshot

- x402 is an open HTTP-native payment standard that uses `402 Payment Required` so a client (human or agent) can pay for a resource without accounts or API keys.
- Coinbase originated the spec; it is now stewarded by the **x402 Foundation under the Linux Foundation** (operational launch 14 Jul 2026). Premier members include Visa, Mastercard, Stripe, Adyen, AWS, Google, Circle, Shopify, Coinbase, Solana Foundation, and others.
- Supported settlement today is dominated by **USDC**. Official docs list Base and Solana (mainnet + testnets) as first-class; Cardano ADA / Cardano stablecoins were merged into the official SDK around 9 Sep 2026. Facilitators exist beyond Coinbase (PayAI, mrdn, Figment, Fluxa, Binance B402 on BNB, etc.).
- V2 wire format uses `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE` (not v1 `X-PAYMENT`). Schemes: `exact`, `upto` (ceiling then capture; Solana `upto` went live in Coinbase facilitator 17 Sep 2026), plus batch / auth-capture work in the Foundation repo.
- Volume trackers disagree on totals but agree on scale: ~188M cumulative settlements and ~$42M USD (agenteconomy.to, 21 Sep 2026); ~75M txs / $24M in the last 30 days (x402.org / Foundation comms). Base is the largest chain. TRM notes most on-chain x402 volume is **not clearly agentic** (scripts, self-dealing, single-contract loops). Organic seller count is small (~78 wallets clearing a real-commerce filter in one Sep 2026 report).

Implication for sellers: **distribution and trust matter more than raw tx counts.** A useful, metered SKU with receipts and Bazaar metadata will out-earn a clone of CoinGecko.

## Agentic.market

Agentic.market is Coinbase/CDP’s discovery layer for x402 services (“app store for agents”, launched 20 Apr 2026). Listing is largely automatic when the CDP facilitator sees Bazaar-enabled metadata on a paid endpoint.

Launch / curated categories and examples:

| Category | Examples |
|---|---|
| Inference | OpenAI, Venice, ElevenLabs |
| Data | CoinGecko, Nansen, Allium, Bloomberg, Google Maps, Zerion |
| Media | dTelecom, Portal Foundation |
| Search | Firecrawl, Browserbase, Exa |
| Social | LinkedIn, X, AgentMail |
| Infrastructure | Alchemy, thirdweb, Pinata, MongoDB, S3, Lambda, QuickNode |
| Trading | Bankr, Coinbase Advanced Trade |

Other indexes (agent402.tools, x402 Bazaar, Agoragentic, OKX agent marketplace) show thousands of advertised endpoints but a long tail of dust. High-settlement hosts tend to sell **infra primitives** (RPC/routing, STT, enrichment) not generic chat.

Recent ecosystem-directory signals (public PRs / radars, mid-Sep 2026): HostDeFi Token Risk API, relay402, Agent Shop, DrinkedIn, Edge Agents AI. Treat these as launch noise until they show organic buyers.

## What AgentWire already sells

`gas-oracle-mcp` already covers a dense commerce stack: webhook inbox, fetch/links/relay, multi-chain gas oracle, 402 decoder, seller risk, preflight, quote compare, endpoint probe, spend planner, settlement verify, payee/token screen, SLA escrow quote, facilitator probe/failover, signed receipts, CAPTCHA HITL, A2A SKUs.

Do **not** clone CoinGecko, Firecrawl, or OpenAI wrappers. Compete on **agent-ops glue** that those brands will not price at $0.002–$0.05 per call.

## Untapped / high-utility SKUs (ranked)

### 1. x402 receipt + SLA pack (bundle)
Agents need machine-readable proof that a paid call settled, what was delivered, and whether the seller missed SLA. You already have settlement verify + signed receipts — productize a **single paid bundle**: verify + hash of response + optional timeout credit quote. Price $0.01–$0.03. Repeat buyers: orchestrators and escrow agents.

### 2. Facilitator / rail health oracle
Coinbase just cut Solana verify to ~75ms and added `upto`. Agents still pick dead facilitators. A live multi-facilitator latency + scheme matrix (exact/upto, Base/Solana) is scarce as a paid MCP tool. Complements existing facilitator probe. Price $0.005.

### 3. Pay-session / budget guard for child agents
TRM: most volume looks like loops. Parent agents will pay for **hard spend caps, allowlists, and per-SKU budgets** before delegating. You have preflight + spend planner — wrap as a session token SKU (`upto` ceiling). This is the closest thing to recurring revenue without subscriptions.

### 4. Sandboxed eval of untrusted seller payloads
OKX marketplace demand for TinyDock-style isolated script runs. Agents buy APIs they do not trust. A short, no-network, CPU-capped eval of JSON/JS snippets (or schema validation + redaction) is useful and legally cleaner than “general compute.” Price $0.02–$0.10.

### 5. Counterparty dossier (not another token-risk clone)
HostDeFi and others are listing token-risk APIs. Gap: **seller host dossier** — first-seen, unique payers, median ticket, 402 header hygiene, Bazaar freshness. You have pieces (seller risk, payee screen). Bundle for $0.02.

### 6. Avoid as first SKUs
Inference resale, Bloomberg/CoinGecko mirrors, social scrapers of X/LinkedIn, physical checkout. Crowded, ToS-fragile, or needs inventory you do not have.

## How money actually shows up

Honest constraints:

- Protocol fees are ~0; you earn **gross USDC at your `payTo`** minus gas (often facilitator-sponsored).
- Median organic seller revenue in one Sep 2026 cut was cents. Top-10 wallets took ~79% of volume.
- “Make money fast” on this rail = (a) ship one SKU agents must call on every hop, (b) get indexed on Agentic.market / Bazaar via real settlements, (c) keep price in the $0.002–$0.05 band so loops can afford it.
- Do not expect human checkout volume. Design for other agents’ inner loops.

## Implementation policy for this repo

- New SKUs belong in `gas-oracle-mcp/src/` as isolated modules + `*.test.ts`, registered from the existing server tool table, with prices in `config.ts`.
- Do not change `payments.ts` header/scheme handling unless a v2 fixture fails.
- Run `npm test` and `npm run smoke-test` in `gas-oracle-mcp` before deploy.
- Mainnet: `NETWORK=base`, real `PAY_TO_ADDRESS`, then one paid call so Bazaar can index.

## Sources (public)

- https://docs.x402.org/introduction
- https://x402.org/
- https://agentic.market/about
- https://www.coinbase.com/en-ca/developer-platform/discover/launches/agentic-market
- https://agenteconomy.to/stats/x402-transactions
- https://www.trmlabs.com/trm-tech-blog/whos-actually-paying-measuring-ai-agent-payments-onchain
- https://solanacompass.com/news/coinbase-upgrades-x402-facilitator-on-solana-upto-scheme-live-verify-latency-cut-66
- https://fintechedition.com/articles/agentic-payments-x402-foundation-standards-2026/
