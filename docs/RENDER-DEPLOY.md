# Deploy AgentWire on Render (free, phone-friendly)

Use this guide if Railway is paused and you only have a phone (e.g. Moto G). Everything is done in the **Render** and **Neon** phone apps or mobile browser — no laptop required.

## What you get on the free tier

| Feature | Works? |
|---|---|
| Webhook inbox (`create_inbox`, `drain_inbox`) | Yes (with Neon Postgres) |
| Web fetch (`fetch_url`) | Yes |
| x402 USDC payments (Base mainnet) | Yes (CDP keys required) |
| Gmail CAPTCHA alerts | Yes (SMTP vars) |
| Human CAPTCHA solve page | Only if you add free Upstash Redis (`REDIS_URL`) |
| SMS (Twilio) | Optional — skip it |

**Free tier caveat:** Render spins the app down after ~15 minutes with no traffic. The first request after sleep takes 30–60 seconds (cold start). Fine for a hobby project.

---

## Part 1 — Free database (Neon, ~5 minutes)

Inbox data must survive redeploys. Render’s free web tier has **no persistent disk**, so use **Neon** (free Postgres):

1. Open [neon.tech](https://neon.tech) on your phone → **Sign up** (GitHub login works).
2. **Create project** → name it `agentwire` → region closest to you → **Create**.
3. On the project dashboard, copy the **connection string** (starts with `postgres://` or `postgresql://`).
4. Save it in your phone notes as `DATABASE_URL` — you’ll paste it into Render later.

---

## Part 2 — Create the Render web service (~10 minutes)

1. Open [render.com](https://render.com) → **Sign up** (use the same GitHub account as your repo).
2. **New +** → **Web Service**.
3. Connect GitHub repo: **`Disseveru/CDP_AGENT_0.01`** (or your fork).
4. Settings:

| Field | Value |
|---|---|
| **Name** | `agentwire` |
| **Region** | Pick closest to you |
| **Root Directory** | `gas-oracle-mcp` |
| **Runtime** | Node |
| **Build Command** | `npm install --legacy-peer-deps && npm run build` |
| **Start Command** | `node dist/migrate.js && node dist/server.js` |
| **Instance type** | **Free** |

5. Expand **Advanced** → **Health Check Path** → `/health`
6. **Do not deploy yet** — add environment variables first (Part 3).

---

## Part 3 — Environment variables (copy into Render → Environment)

Replace the `YOUR_...` placeholders. Add each as **Key** / **Value** in Render.

### Required — Coinbase CDP (same keys as Railway)

Get these from [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com):

```env
CDP_API_KEY=YOUR_CDP_API_KEY_ID
CDP_PRIVATE_KEY=YOUR_CDP_PRIVATE_KEY_PEM
CDP_WALLET_SECRET=YOUR_CDP_WALLET_SECRET
```

### Required — Network + storage

```env
NETWORK=base
STORAGE_BACKEND=postgres
DATABASE_URL=YOUR_NEON_CONNECTION_STRING
```

### Required — Gmail alerts (no Twilio)

```env
OPERATOR_EMAIL=your.email@gmail.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your.email@gmail.com
SMTP_PASS=YOUR_16_CHAR_GMAIL_APP_PASSWORD
```

Gmail app password: [Google App Passwords](https://myaccount.google.com/apppasswords) (requires 2-Step Verification).

### Required — public URL + Cursor MCP auth

After Render gives you a URL like `https://agentwire-xxxx.onrender.com`, add:

```env
PUBLIC_URL=https://agentwire-xxxx.onrender.com
MCP_API_KEY=paste-a-long-random-secret-here
```

`MCP_API_KEY` is **required** on Render (the server refuses to start without it). Without it, `/sse` and `/mcp` would be open to the internet.

Generate a random MCP key on [random.org/strings](https://www.random.org/strings/) (32 chars) or use any long password you save in your notes.

### Optional — CAPTCHA storage (Upstash Redis free tier)

Skip unless you need `request_human_captcha_bypass`:

1. [console.upstash.com](https://console.upstash.com) → free Redis database
2. Copy the **`REDIS_URL`**
3. Add to Render:

```env
REDIS_URL=YOUR_UPSTASH_REDIS_URL
```

### Do NOT set (Twilio disabled)

Leave these **unset**:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`
- `RAILWAY_ENVIRONMENT`

---

## Part 4 — Deploy

1. Click **Create Web Service** (or **Save** then **Manual Deploy**).
2. Wait for the build log to finish (5–10 minutes first time).
3. Open `https://YOUR-SERVICE.onrender.com/health` — expect:

```json
{"status":"ok","service":"AgentWire",...}
```

4. Open `/ready` — expect `"status":"ready"` and a `payTo` wallet address.

If build fails, open the **Logs** tab and search for `Error`.

---

## Part 5 — Connect Cursor (optional, when you use a computer)

From a machine with this repo:

```bash
npm run setup:cursor-mcp -- https://YOUR-SERVICE.onrender.com
npm run verify:cursor-mcp
```

Use the same `MCP_API_KEY` you set in Render.

**Automated setup (when `RENDER_API_KEY` is in Cursor secrets):**

```bash
RENDER_API_KEY=... npm run render:provision -- --redeploy
npm run render:diagnose -- https://YOUR-SERVICE.onrender.com
```

`render:provision` generates `MCP_API_KEY` if missing, sets `PUBLIC_URL`, and triggers a redeploy.

---

## Quick test (any browser)

1. Visit `https://YOUR-SERVICE.onrender.com/` — may return 402 (expected; paid discovery).
2. Health: `/health`
3. Ready: `/ready`

Free tools over MCP: `ping`, `create_inbox`. Paid tools need x402 USDC via Agentic Wallet.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Build fails on `npm install` | Confirm **Root Directory** is `gas-oracle-mcp` and build uses `--legacy-peer-deps` |
| `/health` ok but `/ready` degraded | Check CDP keys — no extra spaces; private key one line with `\n` |
| Inboxes disappear after redeploy | `DATABASE_URL` missing or wrong — use Neon connection string |
| No Gmail alerts | Check `SMTP_PASS` is an **app password**, not your normal Gmail password |
| Slow first request | Free tier cold start — normal |
| CAPTCHA tool errors | Add `REDIS_URL` from Upstash or ignore CAPTCHA tools for now |

---

## Cost summary

| Service | Cost |
|---|---|
| Render web (free) | $0 |
| Neon Postgres (free) | $0 |
| Upstash Redis (optional) | $0 |
| Gmail SMTP | $0 |
| **Total** | **$0/month** |

When you can afford it, upgrade Render to a paid instance ($7/mo) to avoid cold starts:

```bash
RENDER_API_KEY=... npm run render:upgrade-starter
```

Or Render dashboard → your service → **Settings** → **Instance Type** → **Starter** → Save.

**Free keepalive (Cursor Cloud — preferred):** Every agent bootstrap starts a tmux daemon that pings `/health` and `/ready` every 4 minutes. No GitHub Actions billing required.

```bash
npm run render:keepalive:start    # start tmux daemon (also runs on bootstrap:agent)
npm run render:keepalive:status   # check last ping
npm run render:keepalive          # one-shot wake
```

Set `RENDER_KEEPALIVE=0` to skip auto-start during bootstrap. GitHub workflow `.github/workflows/render-keepalive.yml` is **manual-only** (workflow_dispatch) as a fallback.
