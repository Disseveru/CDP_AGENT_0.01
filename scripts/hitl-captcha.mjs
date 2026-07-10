#!/usr/bin/env node
/**
 * Request a human-in-the-loop CAPTCHA solution via production AgentWire.
 *
 * @param {{
 *   sitekey: string,
 *   pageurl: string,
 *   captchaType?: "recaptcha" | "hcaptcha" | "turnstile",
 *   agentwireUrl?: string,
 *   bypassKey?: string,
 * }} options
 * @returns {Promise<{ task_id: string, solve_url: string, solution_token: string }>}
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function loadMcpApiKey() {
  if (process.env.MCP_API_KEY?.trim()) {
    return process.env.MCP_API_KEY.trim();
  }
  const secretsPath = join(repoRoot, ".cursor", "mcp-setup.secrets.json");
  if (!existsSync(secretsPath)) return undefined;
  try {
    const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
    return secrets.mcpApiKey?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function requestHitlCaptchaSolution({
  sitekey,
  pageurl,
  captchaType = "turnstile",
  agentwireUrl = process.env.AGENTWIRE_PRODUCTION_URL ||
    process.env.AGENTWIRE_URL ||
    "https://gas-oracle-mcp-production.up.railway.app",
  bypassKey = process.env.CAPTCHA_DEV_BYPASS_KEY?.trim() || loadMcpApiKey(),
}) {
  const { spawnSync } = await import("node:child_process");
  const gasOracleDir = join(repoRoot, "gas-oracle-mcp");

  const result = spawnSync(
    "npx",
    [
      "tsx",
      "scripts/hitl-captcha-request.ts",
      "--sitekey",
      sitekey,
      "--pageurl",
      pageurl,
      "--type",
      captchaType,
      "--base-url",
      agentwireUrl.replace(/\/$/, ""),
    ],
    {
      cwd: gasOracleDir,
      encoding: "utf8",
      env: {
        ...process.env,
        MCP_API_KEY: bypassKey || process.env.MCP_API_KEY,
        OPERATOR_SMS_NUMBER: process.env.OPERATOR_SMS_NUMBER || "+17472241814",
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || "HITL CAPTCHA request failed");
  }

  const line = result.stdout
    .trim()
    .split("\n")
    .find((l) => l.startsWith("{"));
  if (!line) {
    throw new Error(`No JSON output from hitl-captcha-request: ${result.stdout}`);
  }
  return JSON.parse(line);
}

/**
 * Extract Cloudflare Turnstile sitekey from a Puppeteer page.
 *
 * @param {import('puppeteer-core').Page} page
 */
export async function extractTurnstileSitekey(page) {
  return page.evaluate(() => {
    const widget = document.querySelector(".cf-turnstile[data-sitekey]");
    if (widget?.getAttribute("data-sitekey")) {
      return widget.getAttribute("data-sitekey");
    }
    for (const iframe of document.querySelectorAll("iframe")) {
      const src = iframe.getAttribute("src") || "";
      const match = src.match(/[?&]sitekey=([^&]+)/i);
      if (match) return decodeURIComponent(match[1]);
    }
    for (const script of document.querySelectorAll("script")) {
      const text = script.textContent || "";
      const match = text.match(/sitekey['":\s]+([0-9xA-Za-z_-]{10,})/i);
      if (match) return match[1];
    }
    return null;
  });
}

/**
 * Inject a Turnstile solution token and enable the submit button.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {string} solutionToken
 */
export async function injectTurnstileToken(page, solutionToken) {
  await page.evaluate((token) => {
    const input =
      document.querySelector('input[name="cf-turnstile-response"]') ||
      document.querySelector('textarea[name="cf-turnstile-response"]');
    if (input) {
      input.value = token;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const widget = document.querySelector(".cf-turnstile");
    if (widget) {
      widget.setAttribute("data-response", token);
    }
  }, solutionToken);
}
