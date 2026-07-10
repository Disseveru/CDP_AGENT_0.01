/**
 * Request AgentWire HITL CAPTCHA bypass (developer bypass or x402 payment).
 *
 * Usage:
 *   MCP_API_KEY=... npx tsx scripts/hitl-captcha-request.ts \
 *     --sitekey 0x... --pageurl https://railway.com/login --type turnstile
 *
 * Prints JSON: { task_id, solution_token, solve_url }
 */
import { parseArgs } from "node:util";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { toClientEvmSigner } from "@x402/evm";
import type { ClientEvmSigner } from "@x402/evm";

import {
  createCanonicalLegacyBuyer,
  createLocalEnvBuyer,
  createMainnetPaymasterBuyer,
  toX402Signer,
} from "./buyer-wallet.js";

const DEFAULT_BASE_URL =
  process.env.AGENTWIRE_URL?.replace(/\/$/, "") ||
  process.env.PUBLIC_URL?.replace(/\/$/, "") ||
  "https://gas-oracle-mcp-production.up.railway.app";
const CAIP2_NETWORK = "eip155:8453" as const;
const POLL_INTERVAL_MS = Number(process.env.CAPTCHA_POLL_INTERVAL_MS || 2000);
const POLL_TIMEOUT_MS = Number(process.env.CAPTCHA_POLL_TIMEOUT_MS || 300_000);

const { values: args } = parseArgs({
  options: {
    sitekey: { type: "string" },
    pageurl: { type: "string" },
    type: { type: "string", default: "turnstile" },
    "base-url": { type: "string" },
  },
});

function resolveDevBypassKey(): string | undefined {
  return (
    process.env.CAPTCHA_DEV_BYPASS_KEY?.trim() ||
    process.env.MCP_API_KEY?.trim() ||
    undefined
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollCaptchaSolution(
  baseUrl: string,
  taskId: string,
  pollToken: string,
): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = new URL(`${baseUrl}/api/v1/captcha/status`);
    url.searchParams.set("task_id", taskId);
    url.searchParams.set("poll_token", pollToken);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`CAPTCHA status poll failed: ${res.status} ${await res.text()}`);
    }
    const status = (await res.json()) as {
      status: string;
      solution_token?: string;
    };
    if (status.status === "completed" && status.solution_token) {
      return status.solution_token;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`CAPTCHA task ${taskId} timed out after ${POLL_TIMEOUT_MS}ms`);
}

async function submitCaptchaDevBypass(
  baseUrl: string,
  bypassKey: string,
  body: Record<string, string>,
): Promise<{ task_id: string; solve_url: string; poll_token: string }> {
  console.error(`[hitl-captcha] Developer bypass POST ${baseUrl}/api/v1/captcha/submit`);
  const res = await fetch(`${baseUrl}/api/v1/captcha/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AgentWire-Captcha-Bypass": bypassKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`CAPTCHA submit failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<{ task_id: string; solve_url: string; poll_token: string }>;
}

async function resolveBuyerSigner(): Promise<ClientEvmSigner> {
  try {
    const { ownerProvider } = await createMainnetPaymasterBuyer(5_000n);
    return toX402Signer(ownerProvider);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Insufficient USDC")) {
      throw error;
    }
    console.error("[hitl-captcha] Smart-wallet buyer unfunded; trying local env buyer.");
    try {
      const account = createLocalEnvBuyer();
      const publicClient = createPublicClient({ chain: base, transport: http() });
      return toClientEvmSigner(account, publicClient);
    } catch {
      const { ownerProvider } = await createCanonicalLegacyBuyer();
      return toX402Signer(ownerProvider);
    }
  }
}

async function submitCaptchaPaid(
  baseUrl: string,
  body: Record<string, string>,
): Promise<{ task_id: string; solve_url: string; poll_token: string }> {
  const signer = await resolveBuyerSigner();
  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: CAIP2_NETWORK, client: new ExactEvmScheme(signer) }],
    autoPayment: true,
  });

  console.error(`[hitl-captcha] Paying POST ${baseUrl}/api/v1/captcha/submit via x402...`);
  const res = await fetchWithPayment(`${baseUrl}/api/v1/captcha/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`CAPTCHA submit failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<{ task_id: string; solve_url: string; poll_token: string }>;
}

async function main(): Promise<void> {
  const sitekey = args.sitekey?.trim();
  const pageurl = args.pageurl?.trim();
  const captchaType = (args.type?.trim() || "turnstile") as "recaptcha" | "hcaptcha" | "turnstile";
  const baseUrl = (args["base-url"] || DEFAULT_BASE_URL).replace(/\/$/, "");

  if (!sitekey || !pageurl) {
    throw new Error("Usage: hitl-captcha-request.ts --sitekey <key> --pageurl <url> [--type turnstile]");
  }
  if (!["recaptcha", "hcaptcha", "turnstile"].includes(captchaType)) {
    throw new Error(`Invalid captcha type: ${captchaType}`);
  }

  const body = { sitekey, pageurl, captcha_type: captchaType };
  const bypassKey = resolveDevBypassKey();
  const created = bypassKey
    ? await submitCaptchaDevBypass(baseUrl, bypassKey, body)
    : await submitCaptchaPaid(baseUrl, body);

  console.error(`[hitl-captcha] Task ${created.task_id} created — operator alerted at ${created.solve_url}`);
  console.error(`[hitl-captcha] Waiting for operator to solve (up to ${POLL_TIMEOUT_MS / 1000}s)...`);

  const solutionToken = await pollCaptchaSolution(baseUrl, created.task_id, created.poll_token);

  console.log(
    JSON.stringify({
      task_id: created.task_id,
      solve_url: created.solve_url,
      solution_token: solutionToken,
    }),
  );
}

main().catch((error) => {
  console.error("HITL CAPTCHA request failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
