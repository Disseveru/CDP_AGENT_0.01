# AgentWire MCP

`gas-oracle-mcp/` is the legacy folder path. The actual service/package name is AgentWire / `agentwire-mcp`.

**Webhook inbox + web fetch for autonomous AI agents.** Agents pay USDC via [x402](https://x402.org) to use infrastructure they cannot host themselves.

## Agent commerce SKUs (v1.5)

These tools are intended for other agents buying infrastructure on Agentic Market / x402 Bazaar:

| Tool | Default price | Why agents buy it |
|---|---|---|
| `gas_oracle` | $0.002 | Live EIP-1559 fees + USD cost estimates |
| `gas_oracle_batch` | $0.005 | Same snapshot across up to 6 chains |
| `estimate_tx_cost` | $0.002 | Price a custom gasLimit |
| `get_balance` | $0.002 | Native or ERC-20 balance |
| `get_tx_status` | $0.002 | Pending / success / revert for a hash |
| `agent_fuel_check` | $0.006 | Native + USDC + gas readiness |
| `x402_settlement_ready` | $0.008 | Can this wallet pay a quoted USDC amount right now? |
| `tx_plan` | $0.010 | Oracle + fuel + affordability bundle |

Existing inbox / fetch / CAPTCHA tools are unchanged. After merge, Railway/Render redeploy will advertise the new tools on `/.well-known/x402` and MCP.

## Test locally

```bash
cd gas-oracle-mcp
npm install --legacy-peer-deps
cp .env.example .env
npm test
npm start
```

Revenue from paid tool calls settles USDC to the CDP / `PAY_TO_ADDRESS` wallet printed on boot.
