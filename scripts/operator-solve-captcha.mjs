#!/usr/bin/env node
/**
 * Operator-side CAPTCHA solve via headless Chrome (no desktop required).
 * For cross-domain targets (e.g. Railway), opens the real pageurl and
 * submits the Turnstile token to AgentWire's solve API.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

import { extractTurnstileSitekey } from "./hitl-captcha.mjs";
import { waitForTurnstileToken } from "./desktop-captcha-notify.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function loadMcpApiKey() {
  if (process.env.MCP_API_KEY?.trim()) return process.env.MCP_API_KEY.trim();
  const secretsPath = join(repoRoot, ".cursor", "mcp-setup.secrets.json");
  if (!existsSync(secretsPath)) return undefined;
  const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
  return secrets.mcpApiKey?.trim();
}

const BASE =
  process.env.AGENTWIRE_URL?.replace(/\/$/, "") ||
  process.env.PUBLIC_URL?.replace(/\/$/, "") ||
  "https://gas-oracle-mcp-production.up.railway.app";

const PAGEURL = process.env.CAPTCHA_PAGEURL || "https://railway.com/login";
const SITEKEY = process.env.CAPTCHA_SITEKEY || "0x4AAAAAAADnPIDROrmt1Wwj";

async function submitTask(bypassKey) {
  const res = await fetch(`${BASE}/api/v1/captcha/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AgentWire-Captcha-Bypass": bypassKey,
    },
    body: JSON.stringify({
      sitekey: SITEKEY,
      pageurl: PAGEURL,
      captcha_type: "turnstile",
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`submit failed: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function solveWithBrowser(solveUrl) {
  const puppeteer = await import("puppeteer-core");
  const chromePath =
    process.env.CHROME_PATH ||
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    "/usr/local/bin/google-chrome";

  const browser = await puppeteer.default.launch({
    executablePath: chromePath,
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,900",
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  try {
    const page = await browser.newPage();
    console.log(`Opening ${PAGEURL}...`);
    await page.goto(PAGEURL, { waitUntil: "networkidle2", timeout: 120_000 });

    await page.evaluate(() => {
      document
        .querySelector("button.osano-cm-accept-all, button.osano-cm-denyAll")
        ?.click();
      const link = [...document.querySelectorAll("a, button")].find((el) =>
        /log in using email/i.test(el.textContent || ""),
      );
      link?.click();
    });
    await new Promise((r) => setTimeout(r, 2000));

    const sitekey = (await extractTurnstileSitekey(page)) || SITEKEY;
    console.log(`Turnstile sitekey: ${sitekey}`);
    console.log("Waiting for Turnstile (up to 3 min)...");

    const turnstileToken = await waitForTurnstileToken(page, 180_000);
    console.log(`Turnstile token obtained (${turnstileToken.slice(0, 20)}...)`);

    const taskId = new URL(solveUrl).pathname.split("/").pop();
    const solveToken = new URL(solveUrl).searchParams.get("token");
    if (!taskId || !solveToken) throw new Error(`Invalid solve_url: ${solveUrl}`);

    const solveRes = await fetch(`${BASE}/api/v1/captcha/solve/${taskId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        solution_token: turnstileToken,
        solve_token: solveToken,
      }),
    });
    const solveBody = await solveRes.json();
    if (!solveRes.ok) {
      throw new Error(`solve API failed: ${solveRes.status} ${JSON.stringify(solveBody)}`);
    }

    return { taskId, solveBody, turnstileToken };
  } finally {
    await browser.close();
  }
}

async function main() {
  const bypassKey = loadMcpApiKey();
  if (!bypassKey) throw new Error("MCP_API_KEY not found");

  console.log("=== Submit CAPTCHA task ===");
  const task = await submitTask(bypassKey);
  console.log("task_id:", task.task_id);
  console.log("solve_url:", task.solve_url);

  console.log("\n=== Solve via Chrome (cloud agent browser) ===");
  const result = await solveWithBrowser(task.solve_url);

  const statusUrl = new URL(`${BASE}/api/v1/captcha/status`);
  statusUrl.searchParams.set("task_id", task.task_id);
  statusUrl.searchParams.set("poll_token", task.poll_token);
  const status = await (await fetch(statusUrl)).json();

  console.log("\n=== Final status ===");
  console.log(JSON.stringify(status, null, 2));

  if (status.status !== "completed" || !status.solution_token) {
    throw new Error("Task not completed after solve");
  }

  console.log("\nOperator solve complete — agent can use solution_token.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
