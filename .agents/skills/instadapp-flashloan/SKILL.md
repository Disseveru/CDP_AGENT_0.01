# Instadapp Flashloan Spell Conductor

Execute atomic Instadapp DSA flashloan + swap + payback spells on **Base mainnet (8453)** through the CDP AgentKit tool `execute_flashloan_spell_conductor`.

## When to use

- Flash-borrow ERC-20 tokens via Instadapp `INSTAPOOL-C`
- Swap through a Uniswap V3 pool on Base inside the same atomic spell
- Enforce `minReceiveAmount` slippage protection before payback
- Auto-provision a DSA for the CDP wallet owner when none exists

## Blockchain data sources

Use these canonical references (do not guess RPC URLs or token addresses):

| Source | URL | Use for |
| --- | --- | --- |
| Base docs index | https://docs.base.org/llms.txt | Discover RPC, contracts, AI agent guides |
| Connecting to Base | https://docs.base.org/base-chain/quickstart/connecting-to-base | RPC `https://mainnet.base.org`, chain id `8453` |
| Base contracts | https://docs.base.org/base-chain/network-information/base-contracts | WETH and system contract addresses |
| eth_call | https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_call | Pool token0/token1/fee reads |
| CDP onchain SQL | `.agents/skills/agentic-wallet/references/query-onchain.md` | Optional swap/event history on `base.events` |
| Instadapp unitAmt | https://docs.instadapp.io/faq/connectors/calculate-unitamt | Slippage math for DSA swap connectors |

**Note:** Instadapp's hosted swap router API (`api.instadapp.io/defi/{network}/uniswap/v3/swap/router`) does **not** support Base yet. On Base, pool metadata and decimals are read on-chain via `eth_call` (implemented in `lib/base/blockchain-data.js`).

## Required environment

```bash
NETWORK_ID=base-mainnet
DSA_CHAIN_ID=8453
RPC_URL=https://mainnet.base.org   # optional; defaults to Base docs RPC
DSA_PRIVATE_KEY=0x...              # or MNEMONIC_PHRASE — must match CDP wallet owner EOA
```

## Tool invocation

Registered AgentKit action: **`execute_flashloan_spell_conductor`**

| Field | Type | Description |
| --- | --- | --- |
| `borrowToken` | string | ERC-20 to flash-borrow (e.g. Base USDC `0x833589…`) |
| `borrowAmount` | string | Human-readable amount (e.g. `"10000"`) |
| `targetRoute` | number | Instapool route id (default `1`) |
| `targetDexAddress` | string | Uniswap V3 pool address on Base |
| `minReceiveAmount` | string | Minimum output tokens after swap (slippage floor) |

## Example agent prompt

> Use `execute_flashloan_spell_conductor` on Base mainnet to flash-borrow 10,000 USDC via Instapool route 1, swap through pool `{poolAddress}`, require at least 2.5 WETH received, and pay back the loan atomically. Confirm `NETWORK_ID=base-mainnet` and the DSA owner key is configured before broadcasting.

## Implementation

- Action module: `.agents/skills/instadapp-flashloan.js`
- Base chain reads: `lib/base/blockchain-data.js`
- DSA client helpers: `lib/instadapp/`
