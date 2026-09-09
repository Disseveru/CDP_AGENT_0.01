#!/usr/bin/env node
/**
 * Chrome + MetaMask automation for avocado.instadapp.io Transaction Builder.
 *
 * Imports the operator wallet from MNEMONIC_PHRASE / DSA_PRIVATE_KEY / PRIVATE_KEY,
 * adds Avocado (634) + Base (8453) networks, connects to Avocado, and opens the
 * transaction builder with flash-loan contract calldata from deployments/.
 *
 * Usage:
 *   node scripts/avocado-browser-tx-builder.mjs [--dry-run] [--screenshot-dir /tmp/avocado]
 */

import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const METAMASK_EXT_DIR =
  process.env.METAMASK_EXT_DIR || "/tmp/metamask/metamask-ext";
const CHROME_PATH =
  process.env.CHROME_PATH ||
  "/home/ubuntu/.cache/puppeteer/chrome/linux-150.0.7871.115/chrome-linux64/chrome";
const AVOCADO_URL = process.env.AVOCADO_URL || "https://avocado.instadapp.io";
const DISPLAY = process.env.DISPLAY || ":1";
const METAMASK_PASSWORD = process.env.METAMASK_PASSWORD || "AgentWire2026!";

const BATCH_PATH = path.join(
  process.cwd(),
  "deployments/avocado-batches/flash-arbitrage-8453.json",
);

function parseFlags(argv) {
  const flags = { dryRun: false, screenshotDir: "/tmp/avocado-browser" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dry-run") flags.dryRun = true;
    if (token === "--screenshot-dir" && argv[i + 1]) {
      flags.screenshotDir = argv[i + 1];
      i += 1;
    }
  }
  return flags;
}

function resolveMnemonic() {
  const direct = process.env.DSA_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (direct && direct.trim().split(/\s+/).length >= 12) {
    return direct.trim();
  }
  const mnemonic = process.env.MNEMONIC_PHRASE;
  if (!mnemonic) {
    throw new Error("Set MNEMONIC_PHRASE or a mnemonic in DSA_PRIVATE_KEY/PRIVATE_KEY.");
  }
  return mnemonic.trim();
}

async function screenshot(page, dir, name) {
  if (page.url().startsWith("chrome-extension://")) {
    return null;
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true, timeout: 60_000 });
  console.log(`screenshot: ${file}`);
  return file;
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickByText(page, text, { timeout = 15_000 } = {}) {
  const xpath = `//*[contains(normalize-space(.), '${text}')]`;
  await page.waitForFunction(
    (xp) => {
      const node = document.evaluate(
        xp,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      ).singleNodeValue;
      return Boolean(node);
    },
    { timeout },
    xpath,
  );
  await page.evaluate((xp) => {
    const node = document.evaluate(
      xp,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue;
    if (node instanceof HTMLElement) node.click();
  }, xpath);
}

async function getMetaMaskExtensionId(browser) {
  const extensions = await browser.extensions?.();
  if (extensions) {
    for (const [id, meta] of extensions.entries()) {
      if (/metamask/i.test(meta.name || "")) {
        return id;
      }
    }
  }

  const targets = browser.targets();
  for (const target of targets) {
    const url = target.url();
    const match = url.match(/^chrome-extension:\/\/([a-z]+)\//);
    if (match) return match[1];
  }

  const workerTarget = await browser.waitForTarget(
    (target) =>
      target.type() === "service_worker" &&
      target.url().startsWith("chrome-extension://") &&
      target.url().includes("app-init"),
    { timeout: 60_000 },
  );
  if (!workerTarget) {
    throw new Error("Could not resolve MetaMask extension id.");
  }
  const match = workerTarget.url().match(/^chrome-extension:\/\/([a-z]+)\//);
  if (!match) throw new Error("Could not resolve MetaMask extension id.");
  return match[1];
}

async function cdpClick(page, selector, { timeout = 30_000 } = {}) {
  const client = await page.createCDPSession();
  const start = Date.now();
  let nodeId = 0;
  while (Date.now() - start < timeout) {
    const { root } = await client.send("DOM.getDocument");
    const found = await client.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    });
    nodeId = found.nodeId;
    if (nodeId) break;
    await delay(250);
  }
  if (!nodeId) {
    throw new Error(`Selector not found: ${selector}`);
  }
  await client.send("DOM.scrollIntoViewIfNeeded", { nodeId });
  const box = await client.send("DOM.getBoxModel", { nodeId });
  const content = box.model.content;
  const x = (content[0] + content[4]) / 2;
  const y = (content[1] + content[5]) / 2;
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function cdpType(page, selector, text, { timeout = 30_000 } = {}) {
  await cdpClick(page, selector, { timeout });
  for (const char of text) {
    await page.keyboard.sendCharacter(char);
  }
}

async function clickSelector(page, selector, options) {
  return cdpClick(page, selector, options);
}

async function typeSelector(page, selector, text, options) {
  return cdpType(page, selector, text, options);
}

async function setupMetaMask(browser, extId, mnemonic, screenshotDir) {
  const mmUrl = `chrome-extension://${extId}/home.html`;
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto(mmUrl, { waitUntil: "networkidle2", timeout: 120_000 });
  await delay(3000);
  await screenshot(page, screenshotDir, "01-metamask-home");

  try {
    await cdpClick(page, '[data-testid="onboarding-terms-checkbox"]');
    await delay(500);
  } catch {
    /* optional */
  }

  try {
    await cdpClick(page, '[data-testid="onboarding-import-wallet"]');
    await delay(1500);
    await screenshot(page, screenshotDir, "02-metamask-import-start");

    try {
      await clickSelector(page, '[data-testid="onboarding-import-with-srp-button"]');
    } catch {
      /* already on SRP screen */
    }

    await delay(2000);
    const words = mnemonic.split(/\s+/);
    for (const selector of [
      "textarea.import-srp__srp",
      '[data-testid="srp-input-import__srp-note"]',
      "textarea",
    ]) {
      try {
        await cdpType(page, selector, words.join(" "));
        break;
      } catch {
        /* try next */
      }
    }

    await delay(500);
    for (const selector of [
      '[data-testid="import-srp-confirm"]',
      '[data-testid="confirm-srp"]',
      "button.btn-primary",
      "button.mm-button-primary",
    ]) {
      try {
        await cdpClick(page, selector);
        break;
      } catch {
        /* try next */
      }
    }
    await delay(1000);

    await typeSelector(page, '[data-testid="create-password-new-input"]', METAMASK_PASSWORD);
    await typeSelector(page, '[data-testid="create-password-confirm-input"]', METAMASK_PASSWORD);
    try {
      await clickSelector(page, '[data-testid="create-password-terms"]');
    } catch {
      /* optional */
    }
    await clickSelector(page, '[data-testid="create-password-import"]');
    await delay(1500);

    try {
      await clickSelector(page, '[data-testid="metametrics-no-thanks"]');
    } catch {
      try {
        await clickSelector(page, '[data-testid="metametrics-i-agree"]');
      } catch {
        /* optional */
      }
    }

    try {
      await clickSelector(page, '[data-testid="onboarding-complete-done"]');
    } catch {
      try {
        await clickSelector(page, '[data-testid="pin-extension-next"]');
        await delay(500);
        await clickSelector(page, '[data-testid="pin-extension-done"]');
      } catch {
        /* optional */
      }
    }

    await delay(2000);
    await screenshot(page, screenshotDir, "03-metamask-imported");
  } catch (error) {
    console.log(`MetaMask onboarding skipped or already complete: ${error.message}`);
  }

  await page.close();
}

async function addNetworkViaDapp(page, network) {
  await page.goto("https://chainlist.org", { waitUntil: "networkidle2", timeout: 120_000 });
  await delay(2000);
  try {
    await page.evaluate(async (params) => {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [params],
      });
    }, {
      chainId: `0x${network.chainId.toString(16)}`,
      chainName: network.name,
      rpcUrls: [network.rpcUrl],
      nativeCurrency: { name: network.symbol, symbol: network.symbol, decimals: 18 },
    });
  } catch (error) {
    console.log(`Network add skipped (${network.name}): ${error.message}`);
  }

  const pages = await page.browser().pages();
  for (const popup of pages) {
    if (popup.url().startsWith("chrome-extension://")) {
      try {
        await cdpClick(popup, '[data-testid="confirmation-submit-button"]');
      } catch {
        try {
          await cdpClick(popup, '[data-testid="page-container-footer-next"]');
          await delay(500);
          await cdpClick(popup, '[data-testid="page-container-footer-next"]');
        } catch {
          /* ignore */
        }
      }
    }
  }
}

async function connectAvocado(browser, screenshotDir, batch) {
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);

  await page.goto(`${AVOCADO_URL}/transaction-builder`, {
    waitUntil: "networkidle2",
    timeout: 120_000,
  });
  await delay(4000);
  await screenshot(page, screenshotDir, "10-avocado-transaction-builder");

  try {
    const buttons = await page.$$("button, a, div[role='button']");
    for (const button of buttons) {
      const text = await button.evaluate((el) => el.textContent?.trim() || "");
      if (text === "MetaMask" || /^MetaMask$/i.test(text)) {
        await button.click();
        console.log("Clicked MetaMask on Avocado login page.");
        break;
      }
    }
  } catch (error) {
    console.log(`MetaMask button click failed: ${error.message}`);
  }

  await delay(3000);
  await screenshot(page, screenshotDir, "11-avocado-metamask-clicked");

  const pages = await browser.pages();
  for (const p of pages) {
    if (!p.url().startsWith("chrome-extension://")) continue;
    for (const selector of [
      '[data-testid="confirm-btn"]',
      '[data-testid="confirmation-submit-button"]',
      '[data-testid="page-container-footer-next"]',
      '[data-testid="connect-btn"]',
    ]) {
      try {
        await cdpClick(p, selector);
        await delay(800);
      } catch {
        /* ignore */
      }
    }
  }

  await delay(5000);
  await screenshot(page, screenshotDir, "12-avocado-connected");

  const primaryTx = batch.shortcut?.primaryTx || batch.transactions?.[0];
  if (primaryTx) {
    console.log(
      JSON.stringify(
        {
          step: "flash-loan-tx-ready",
          network: "Base",
          chainId: batch.chainId,
          avocadoSafe: batch.avocadoSafe,
          flashLoanReceiver: batch.flashLoanReceiver,
          to: primaryTx.to,
          data: primaryTx.data,
          value: primaryTx.value || "0",
          note:
            "Paste to/ data/ value into Avocado Transaction Builder custom call step. " +
            "Only execute when scanner reports profit > flash fee.",
        },
        null,
        2,
      ),
    );
  }

  return { page, batch, primaryTx };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const mnemonic = resolveMnemonic();

  if (!fs.existsSync(METAMASK_EXT_DIR)) {
    throw new Error(
      `MetaMask extension not found at ${METAMASK_EXT_DIR}. Run the download step first.`,
    );
  }
  if (!fs.existsSync(BATCH_PATH)) {
    throw new Error(`Missing batch JSON at ${BATCH_PATH}. Run npm run dsa:build-avocado-batch.`);
  }

  const batch = JSON.parse(fs.readFileSync(BATCH_PATH, "utf8"));
  const userDataDir = path.join("/tmp", "chrome-avocado-profile");
  fs.mkdirSync(userDataDir, { recursive: true });

  console.log(`Launching Chrome on DISPLAY=${DISPLAY} with MetaMask...`);
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    pipe: true,
    enableExtensions: [METAMASK_EXT_DIR],
    userDataDir,
    protocolTimeout: 180_000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1400,900",
      "--disable-blink-features=AutomationControlled",
    ],
    defaultViewport: { width: 1400, height: 900 },
  });

  try {
    const extId = await getMetaMaskExtensionId(browser);
    console.log(`MetaMask extension id: ${extId}`);

    await setupMetaMask(browser, extId, mnemonic, flags.screenshotDir);

    const { page } = await connectAvocado(browser, flags.screenshotDir, batch);

    if (flags.dryRun) {
      console.log("Dry run complete — wallet imported and Avocado opened.");
    } else {
      console.log(
        "Browser session ready. Avocado Transaction Builder is open with flash-loan calldata logged above.",
      );
      await delay(5000);
    }

    await screenshot(page, flags.screenshotDir, "99-final");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
