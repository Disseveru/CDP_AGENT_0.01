#!/usr/bin/env node
/**
 * Create a Railway account using an AgentWire inbox email, then wire the GitHub repo.
 *
 * Flow:
 *   1. create_inbox → agentEmail ({inboxId}@AGENT_EMAIL_DOMAIN via mail.tm)
 *   2. Chrome: Railway email signup with agentEmail
 *   3. Poll mail.tm → relay verification email into AgentWire webhook inbox
 *   4. peek_inbox / file read → extract magic link → finish Railway login in Chrome
 *   5. Deploy Disseveru/CDP_AGENT_0.01 from GitHub (operator may need to authorize GitHub once)
 *
 * Usage:
 *   DISPLAY=:1 npm run railway:inbox-signup
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createMailTmAccount,
  extractFirstUrl,
  getMailTmToken,
  listMailTmDomains,
  relayNewMailToWebhook,
  waitForEmailRelay,
} from "./inbox-email-bridge.mjs";
import {
  extractTurnstileSitekey,
  injectTurnstileToken,
  requestHitlCaptchaSolution,
} from "./hitl-captcha.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const artifactDir = "/opt/cursor/artifacts/screenshots";
const statePath = join(repoRoot, ".cursor", "railway-signup-inbox.json");

const AGENTWIRE_URL = process.env.AGENTWIRE_URL || "http://localhost:4021";
const HITL_CAPTCHA_URL =
  process.env.HITL_CAPTCHA_URL ||
  process.env.AGENTWIRE_PRODUCTION_URL ||
  "https://gas-oracle-mcp-production.up.railway.app";
const MCP_API_KEY = process.env.MCP_API_KEY || "local-dev-mcp-key";
const GITHUB_REPO = "Disseveru/CDP_AGENT_0.01";

async function loadPuppeteer() {
  try {
    return await import("puppeteer-core");
  } catch {
    const { spawnSync } = await import("node:child_process");
    spawnSync("npm", ["install", "puppeteer-core@24", "--no-save"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    return import("puppeteer-core");
  }
}

async function screenshot(page, name) {
  mkdirSync(artifactDir, { recursive: true });
  const path = join(artifactDir, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`screenshot: ${path}`);
}

async function createAgentInbox() {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    "npx",
    ["tsx", "--input-type=module", "-e", `import { createInbox } from './src/inbox.ts'; console.log(JSON.stringify(await createInbox()));`],
    {
      cwd: join(repoRoot, "gas-oracle-mcp"),
      encoding: "utf8",
      env: {
        ...process.env,
        TWILIO_ACCOUNT_SID: "",
        TWILIO_AUTH_TOKEN: "",
        TWILIO_FROM_NUMBER: "",
        SMTP_PASS: "",
        MCP_API_KEY,
        AGENT_EMAIL_DOMAIN: process.env.AGENT_EMAIL_DOMAIN,
        PUBLIC_URL: AGENTWIRE_URL,
        STORAGE_BACKEND: "file",
        DATA_DIR: "./data/inboxes",
        NETWORK: "base-sepolia",
        FACILITATOR_URL: "https://x402.org/facilitator",
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "createInbox failed");
  }
  const line = result.stdout.trim().split("\n").at(-1);
  return JSON.parse(line);
}

async function readInboxEvents(inboxId) {
  const recordPath = join(repoRoot, "gas-oracle-mcp", "data", "inboxes", `${inboxId}.json`);
  if (!existsSync(recordPath)) return [];
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  return record.events || [];
}

async function railwayEmailSignup(page, agentEmail) {
  console.log(`Railway email signup: ${agentEmail}`);
  await page.goto("https://railway.com/login", { waitUntil: "networkidle2" });
  await screenshot(page, "railway-01-login");

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

  const emailInput = await page.$('input[type="email"], input[name="email"]');
  if (!emailInput) throw new Error("Railway email input not found");
  await emailInput.click({ clickCount: 3 });
  await emailInput.type(agentEmail, { delay: 15 });
  await screenshot(page, "railway-02-email-filled");

  // Railway shows Cloudflare Turnstile before "Continue with Email".
  const pageUrl = page.url();
  const sitekey = await extractTurnstileSitekey(page);
  if (!sitekey) {
    throw new Error("Could not find Cloudflare Turnstile sitekey on Railway login page");
  }

  console.log("");
  console.log(`Turnstile sitekey: ${sitekey}`);
  console.log(`Requesting HITL CAPTCHA via ${HITL_CAPTCHA_URL}...`);
  console.log("Operator will receive ntfy push with solve link — complete Turnstile on phone.");

  const captcha = await requestHitlCaptchaSolution({
    sitekey,
    pageurl: pageUrl,
    captchaType: "turnstile",
    agentwireUrl: HITL_CAPTCHA_URL,
  });

  console.log(`HITL CAPTCHA solved (task ${captcha.task_id})`);
  await injectTurnstileToken(page, captcha.solution_token);
  await screenshot(page, "railway-02b-captcha-solved");

  const continueEmail = await page.evaluateHandle(() => {
    const buttons = [...document.querySelectorAll("button")];
    return buttons.find((b) => /continue with email/i.test(b.textContent || ""));
  });
  const continueEl = continueEmail.asElement();
  if (!continueEl) throw new Error('Railway "Continue with Email" button not found');
  await continueEl.click();
  await screenshot(page, "railway-03-email-submitted");
  console.log("Clicked Continue with Email — waiting for magic link in AgentWire inbox...");
}

async function tryGitHubDeploy(page) {
  console.log("Opening Railway GitHub deploy wizard...");
  await page.goto("https://railway.com/new/github", { waitUntil: "networkidle2" });
  await screenshot(page, "railway-05-github-wizard");

  if (/github\.com/i.test(page.url())) {
    console.log("GitHub OAuth required to connect repo — waiting up to 3 min for redirect...");
    await page
      .waitForFunction(
        () => /railway\.com/i.test(window.location.href),
        { timeout: 180_000 },
      )
      .catch(() => undefined);
  }

  // Search/select repo in Railway UI when available.
  await page.evaluate((repo) => {
    const input = document.querySelector('input[type="search"], input[placeholder*="Search" i]');
    if (input) {
      input.value = repo.split("/")[1];
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, GITHUB_REPO);
  await new Promise((r) => setTimeout(r, 2000));
  await screenshot(page, "railway-06-repo-search");

  const clicked = await page.evaluate((repo) => {
    const nodes = [...document.querySelectorAll("button, a, div, span")];
    const match = nodes.find((el) => (el.textContent || "").includes(repo.split("/")[1]));
    match?.click();
    return Boolean(match);
  }, GITHUB_REPO);
  console.log(`Repo click attempted: ${clicked}`);
  await new Promise((r) => setTimeout(r, 5000));
  await screenshot(page, "railway-07-after-repo-select");
}

async function extractMagicLinkFromInbox(inboxId) {
  const events = await readInboxEvents(inboxId);
  for (const event of events.slice().reverse()) {
    const body = event.body;
    const text =
      typeof body === "string"
        ? body
        : body?.text || body?.html || body?.intro || JSON.stringify(body);
    const url = extractFirstUrl(text);
    if (url && /railway\.com|backboard\.railway/i.test(url)) {
      return url;
    }
  }
  return undefined;
}

async function main() {
  const display = process.env.DISPLAY || ":1";
  process.env.DISPLAY = display;
  console.log("Railway inbox signup");
  console.log(`AgentWire (inbox): ${AGENTWIRE_URL}`);
  console.log(`HITL CAPTCHA:       ${HITL_CAPTCHA_URL}`);
  console.log("");

  const domains = await listMailTmDomains();
  const domain = process.env.AGENT_EMAIL_DOMAIN || domains[0];
  if (!domain) throw new Error("No mail.tm domains available");

  const inbox = await createAgentInbox();
  const mailPassword = randomBytes(18).toString("base64url");
  const mailAccount = await createMailTmAccount(inbox.inboxId, domain, mailPassword);
  const agentEmail = mailAccount.address;
  const mailToken = await getMailTmToken(agentEmail, mailPassword);

  const state = {
    ...inbox,
    agentEmail,
    mailPassword,
    mailDomain: domain,
    githubRepo: GITHUB_REPO,
    createdAt: new Date().toISOString(),
  };
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  console.log(`AgentWire inbox: ${inbox.inboxId}`);
  console.log(`Agent email:     ${agentEmail}`);
  console.log(`Webhook URL:     ${inbox.webhookUrl}`);
  console.log("");

  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch({
    executablePath: "/opt/google/chrome/google-chrome",
    headless: false,
    userDataDir: join(repoRoot, ".cursor", "chrome-railway-inbox-profile"),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1400,900"],
    defaultViewport: { width: 1400, height: 900 },
  });
  const page = (await browser.pages())[0] || (await browser.newPage());

  try {
    await railwayEmailSignup(page, agentEmail);
    console.log("Waiting for Railway verification email...");
    const relayed = await waitForEmailRelay({
      token: mailToken,
      webhookUrl: inbox.webhookUrl,
      timeoutMs: 300_000,
    });
    console.log(`Relayed ${relayed.length} email(s) into AgentWire inbox`);

    const magicLink =
      (await extractMagicLinkFromInbox(inbox.inboxId)) ||
      extractFirstUrl(
        (
          await readInboxEvents(inbox.inboxId).then((events) => {
            const last = events.at(-1)?.body;
            return typeof last === "string" ? last : last?.text || last?.html || "";
          })
        ),
      );

    if (!magicLink) {
      throw new Error("No Railway magic link found in AgentWire inbox after email relay");
    }

    console.log(`Magic link: ${magicLink.slice(0, 80)}...`);
    await page.goto(magicLink, { waitUntil: "networkidle2" });
    await screenshot(page, "railway-03-logged-in");
    console.log(`Logged in URL: ${page.url()}`);

    if (/railway\.com/i.test(page.url()) && !/login/i.test(page.url())) {
      await tryGitHubDeploy(page);
    }

    writeFileSync(
      join(artifactDir, "railway-inbox-signup-result.json"),
      JSON.stringify(
        {
          agentEmail,
          inboxId: inbox.inboxId,
          finalUrl: page.url(),
          relayed,
          completedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.log("");
    console.log("Railway account created with AgentWire inbox email.");
    console.log("Next: copy Railway API token from dashboard → RAILWAY_TOKEN, then npm run railway:init -- --redeploy");
  } finally {
    console.log("Leaving browser open 3 minutes for CAPTCHA / GitHub OAuth if needed...");
    await new Promise((r) => setTimeout(r, 180_000));
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
