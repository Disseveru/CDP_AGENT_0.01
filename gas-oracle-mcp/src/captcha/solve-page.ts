import { captchaWidgetScript } from "./tasks.js";
import { escapeHtml, escapeHtmlAttribute } from "./html.js";
import type { CaptchaTask } from "./types.js";

export function renderSolvePage(task: CaptchaTask): string {
  const { scriptUrl, globalName } = captchaWidgetScript(task.captcha_type);
  const sitekey = escapeHtmlAttribute(task.sitekey);
  const taskId = escapeHtmlAttribute(task.task_id);
  const pageurl = escapeHtml(task.pageurl);

  const widgetMount =
    task.captcha_type === "turnstile"
      ? `<div id="captcha-widget" class="cf-turnstile" data-sitekey="${sitekey}"></div>`
      : `<div id="captcha-widget"></div>`;

  const renderScript =
    task.captcha_type === "recaptcha"
      ? `grecaptcha.render("captcha-widget", { sitekey: "${sitekey}" });`
      : task.captcha_type === "hcaptcha"
        ? `hcaptcha.render("captcha-widget", { sitekey: "${sitekey}" });`
        : `/* turnstile auto-renders via data-sitekey */`;

  const extractToken =
    task.captcha_type === "recaptcha"
      ? `const token = grecaptcha.getResponse();`
      : task.captcha_type === "hcaptcha"
        ? `const token = hcaptcha.getResponse();`
        : `const token = document.querySelector('[name="cf-turnstile-response"]')?.value || turnstile.getResponse();`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Solve CAPTCHA</title>
  <script src="${scriptUrl}" async defer></script>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      display: flex;
      flex-direction: column;
      padding: env(safe-area-inset-top) 1rem env(safe-area-inset-bottom);
    }
    header { padding: 1rem 0 0.5rem; }
    h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
    .meta { font-size: 0.8rem; color: #94a3b8; word-break: break-all; }
    main {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1.25rem;
      padding: 1rem 0 2rem;
    }
    #captcha-widget { min-height: 78px; }
    button {
      width: 100%;
      max-width: 320px;
      padding: 0.9rem 1rem;
      font-size: 1rem;
      font-weight: 600;
      border: none;
      border-radius: 12px;
      background: #22c55e;
      color: #052e16;
      cursor: pointer;
    }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    #status { font-size: 0.9rem; text-align: center; min-height: 1.25rem; }
    .ok { color: #4ade80; }
    .err { color: #f87171; }
  </style>
</head>
<body>
  <header>
    <h1>Human CAPTCHA solve</h1>
    <p class="meta">Task ${taskId}</p>
    <p class="meta">${pageurl}</p>
  </header>
  <main>
    ${widgetMount}
    <button id="submit-btn" type="button">Submit Solution</button>
    <p id="status"></p>
  </main>
  <script>
    const TASK_ID = "${taskId}";
    const statusEl = document.getElementById("status");
    const submitBtn = document.getElementById("submit-btn");

    function setStatus(msg, cls) {
      statusEl.textContent = msg;
      statusEl.className = cls || "";
    }

    function waitForGlobal(name, timeoutMs) {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        (function poll() {
          if (window[name]) return resolve(window[name]);
          if (Date.now() - start > timeoutMs) return reject(new Error(name + " failed to load"));
          setTimeout(poll, 100);
        })();
      });
    }

    window.addEventListener("load", async () => {
      try {
        await waitForGlobal("${globalName}", 15000);
        ${renderScript}
      } catch (e) {
        setStatus("Failed to load CAPTCHA widget.", "err");
        submitBtn.disabled = true;
      }
    });

    submitBtn.addEventListener("click", async () => {
      try {
        ${extractToken}
        if (!token) {
          setStatus("Complete the CAPTCHA first.", "err");
          return;
        }
        submitBtn.disabled = true;
        setStatus("Submitting…", "");
        const res = await fetch("/api/v1/captcha/solve/" + TASK_ID, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ solution_token: token }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || res.statusText);
        setStatus("✓ Solution saved. Agent can poll status now.", "ok");
      } catch (e) {
        setStatus(e.message || "Submit failed", "err");
        submitBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}
