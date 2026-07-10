#!/usr/bin/env node
/**
 * Launch Chrome on the desktop display and drive Railway GitHub signup.
 * Saves screenshots to /opt/cursor/artifacts/screenshots/ for debugging.
 *
 * Usage:
 *   DISPLAY=:1 node scripts/railway-browser-signup.mjs
 *   DISPLAY=:1 node scripts/railway-browser-signup.mjs --screenshot-only
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const artifactDir = "/opt/cursor/artifacts/screenshots";

const { values: args } = parseArgs({
  options: {
    "screenshot-only": { type: "boolean", default: false },
    "email-only": { type: "boolean", default: false },
    headless: { type: "boolean", default: false },
  },
});

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

async function tryEmailSignup(page) {
  const operatorEmail = process.env.OPERATOR_EMAIL?.trim() || "er2k18@gmail.com";
  console.log(`Trying Railway email signup for ${operatorEmail}...`);
  await page.goto("https://railway.com/login", { waitUntil: "networkidle2" });
  await page.evaluate(() => {
    const link = [...document.querySelectorAll("a, button")].find((el) =>
      /log in using email|email/i.test(el.textContent || ""),
    );
    link?.click();
  });
  await new Promise((r) => setTimeout(r, 2000));
  await screenshot(page, "05-email-login-form");
  const emailInput = await page.$('input[type="email"], input[name="email"]');
  if (!emailInput) {
    console.log("Email input not found — operator may need to complete GitHub OAuth manually.");
    return false;
  }
  await emailInput.click({ clickCount: 3 });
  await emailInput.type(operatorEmail, { delay: 20 });
  await screenshot(page, "06-email-filled");
  const submit = await page.evaluateHandle(() => {
    const buttons = [...document.querySelectorAll("button")];
    return buttons.find((b) => /continue|sign in|log in|send/i.test(b.textContent || ""));
  });
  const submitEl = submit.asElement();
  if (submitEl) await submitEl.click();
  await new Promise((r) => setTimeout(r, 3000));
  await screenshot(page, "07-email-submitted");
  console.log("");
  console.log(`Railway magic-link email sent to ${operatorEmail}.`);
  console.log("Operator: open the email and click the Railway login link, or paste the URL here.");
  return true;
}

async function screenshot(page, name) {
  mkdirSync(artifactDir, { recursive: true });
  const path = join(artifactDir, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`screenshot: ${path}`);
  return path;
}

async function main() {
  const display = process.env.DISPLAY || ":1";
  process.env.DISPLAY = display;
  console.log(`Railway browser signup (DISPLAY=${display})`);

  const puppeteer = await loadPuppeteer();
  const chromePath = "/opt/google/chrome/google-chrome";
  const userDataDir = join(repoRoot, ".cursor", "chrome-railway-profile");
  mkdirSync(userDataDir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: args.headless,
    userDataDir,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1400,900",
      "--disable-blink-features=AutomationControlled",
    ],
    defaultViewport: { width: 1400, height: 900 },
  });

  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  page.setDefaultTimeout(60_000);

  try {
    console.log("Opening railway.com/login...");
    await page.goto("https://railway.com/login", { waitUntil: "networkidle2" });
    await screenshot(page, "01-railway-login");

    if (args["screenshot-only"]) {
      writeFileSync(
        join(artifactDir, "state.json"),
        JSON.stringify({ url: page.url(), title: await page.title() }, null, 2),
      );
      return;
    }

    if (args["email-only"]) {
      await tryEmailSignup(page);
      console.log("Waiting up to 5 minutes for Railway email magic link...");
      await page
        .waitForFunction(
          () =>
            /railway\.com/i.test(window.location.href) &&
            !/login/i.test(window.location.pathname),
          { timeout: 300_000 },
        )
        .catch(() => console.log("Timed out waiting for email login."));
    } else {
    const githubButton = await page.evaluateHandle(() => {
      const buttons = [...document.querySelectorAll("button, a")];
      return buttons.find((el) => /continue with github/i.test(el.textContent || ""));
    });
    const githubEl = githubButton.asElement();
    if (githubEl) {
      await githubEl.click();
      console.log('Clicked "Continue with GitHub" button');
    } else {
      throw new Error('Could not find "Continue with GitHub" button');
    }

    await new Promise((r) => setTimeout(r, 3000));
    await screenshot(page, "02-after-github-click");

    const currentUrl = page.url();
    console.log(`Current URL: ${currentUrl}`);

    if (/github\.com/i.test(currentUrl)) {
      console.log("");
      console.log("GitHub OAuth page reached — no saved GitHub session in Chrome.");
      const usedEmail = await tryEmailSignup(page);
      if (!usedEmail) {
        console.log("Waiting up to 3 minutes for manual GitHub sign-in + Railway redirect...");
        await page
          .waitForFunction(
            () =>
              /railway\.com/i.test(window.location.href) &&
              !/login/i.test(window.location.pathname),
            { timeout: 180_000 },
          )
          .catch(() => {
            console.log("Timed out waiting for Railway redirect — complete GitHub login in desktop Chrome.");
          });
      } else {
        console.log("Waiting up to 5 minutes for operator to click Railway email magic link...");
        await page
          .waitForFunction(
            () =>
              /railway\.com/i.test(window.location.href) &&
              !/login/i.test(window.location.pathname),
            { timeout: 300_000 },
          )
          .catch(() => {
            console.log("Timed out — click the Railway login link from email in desktop Chrome.");
          });
      }
    }
    }

    await screenshot(page, "03-railway-after-oauth");
    console.log(`Final URL: ${page.url()}`);

    // Navigate to new project from GitHub if logged in
    if (/railway\.com/i.test(page.url()) && !/login/i.test(page.url())) {
      console.log("Opening new project wizard...");
      await page.goto("https://railway.com/new/github", { waitUntil: "networkidle2" });
      await screenshot(page, "04-new-github-project");
      console.log(`Project wizard URL: ${page.url()}`);
    }

    writeFileSync(
      join(artifactDir, "railway-signup-state.json"),
      JSON.stringify(
        {
          url: page.url(),
          title: await page.title(),
          display,
          completedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } finally {
    if (!args.headless && !args["screenshot-only"]) {
      const waitMs = args["email-only"] ? 1_800_000 : 30_000;
      console.log(`Leaving browser open ${waitMs / 1000}s for operator login in desktop Chrome...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
