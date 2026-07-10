#!/usr/bin/env node
/**
 * Send a single operator ntfy push asking them to complete a CAPTCHA in desktop
 * Chrome (same browser session). Cross-domain Turnstile solve links do not work.
 *
 * @param {{ title?: string, lines?: string[] }} [options]
 */
export async function notifyDesktopCaptchaAction(options = {}) {
  const topic = process.env.NTFY_TOPIC?.trim();
  if (!topic) {
    console.log("NTFY_TOPIC not set — complete the CAPTCHA in desktop Chrome manually.");
    return false;
  }

  const server = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
  const title = options.title || "Action needed in desktop Chrome";
  const body = (options.lines || [
    "Complete the Cloudflare checkbox in the Cursor desktop Chrome window.",
    "",
    "Do NOT use old CAPTCHA solve links from earlier alerts — they cannot work for Railway.",
    "Ignore any IP-copy pages; just click the checkbox on the Railway login page in Chrome.",
  ]).join("\n");

  const headers = {
    Title: title,
    Priority: "high",
    Tags: "warning,desktop_computer",
  };
  const token = process.env.NTFY_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${server}/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`ntfy desktop alert failed (${response.status}): ${detail}`);
  }

  console.log(`Desktop CAPTCHA alert sent to ${server}/${topic}`);
  return true;
}

/**
 * Poll a Puppeteer page until Turnstile writes a response token in-page.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {number} [timeoutMs]
 */
export async function waitForTurnstileToken(page, timeoutMs = 300_000) {
  const handle = await page.waitForFunction(
    () => {
      const input =
        document.querySelector('input[name="cf-turnstile-response"]') ||
        document.querySelector('textarea[name="cf-turnstile-response"]');
      if (input?.value) return input.value;
      const widget = document.querySelector(".cf-turnstile[data-response]");
      const attr = widget?.getAttribute("data-response");
      if (attr) return attr;
      return null;
    },
    { timeout: timeoutMs, polling: 500 },
  );
  const token = await handle.jsonValue();
  if (!token || typeof token !== "string") {
    throw new Error("Turnstile token missing after wait");
  }
  return token;
}
