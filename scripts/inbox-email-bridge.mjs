/**
 * Disposable email bridge: poll mail.tm and relay messages into AgentWire webhook inboxes.
 */
const MAIL_TM_API = "https://api.mail.tm";

/**
 * @param {string} domain e.g. web-library.net
 */
export async function createMailTmAccount(inboxId, domain, password) {
  const address = `${inboxId}@${domain}`;
  const res = await fetch(`${MAIL_TM_API}/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, password }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`mail.tm account create failed (${res.status}): ${body}`);
  }
  return { address, password, ...(await res.json()) };
}

export async function getMailTmToken(address, password) {
  const res = await fetch(`${MAIL_TM_API}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, password }),
  });
  if (!res.ok) {
    throw new Error(`mail.tm token failed (${res.status})`);
  }
  const data = await res.json();
  return data.token;
}

export async function listMailTmDomains() {
  const res = await fetch(`${MAIL_TM_API}/domains`);
  if (!res.ok) throw new Error(`mail.tm domains failed (${res.status})`);
  const data = await res.json();
  return data["hydra:member"].map((d) => d.domain);
}

/**
 * @param {string} token
 * @param {string} messageId
 */
export async function fetchMailTmMessage(token, messageId) {
  const res = await fetch(`${MAIL_TM_API}/messages/${messageId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`mail.tm message fetch failed (${res.status})`);
  return res.json();
}

/**
 * @param {string} token
 */
export async function listMailTmMessages(token) {
  const res = await fetch(`${MAIL_TM_API}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`mail.tm messages list failed (${res.status})`);
  const data = await res.json();
  return data["hydra:member"] || [];
}

/**
 * Relay new mail.tm messages into an AgentWire webhook inbox.
 *
 * @param {{
 *   token: string,
 *   webhookUrl: string,
 *   seen?: Set<string>,
 * }} options
 */
export async function relayNewMailToWebhook({ token, webhookUrl, seen = new Set() }) {
  const messages = await listMailTmMessages(token);
  /** @type {import('./inbox-email-bridge.mjs').RelayedMessage[]} */
  const relayed = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    const full = await fetchMailTmMessage(token, message.id);
    const payload = {
      type: "email",
      provider: "mail.tm",
      messageId: message.id,
      from: full.from?.address || message.from?.address,
      subject: full.subject,
      text: full.text,
      html: full.html,
      intro: message.intro,
      receivedAt: message.createdAt,
    };
    const hookRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!hookRes.ok) {
      throw new Error(`webhook relay failed (${hookRes.status})`);
    }
    relayed.push({ messageId: message.id, subject: full.subject, hookStatus: hookRes.status });
  }
  return relayed;
}

/**
 * @param {string} text
 * @returns {string | undefined}
 */
export function extractFirstUrl(text) {
  if (!text) return undefined;
  const match = text.match(/https?:\/\/[^\s<>"')]+/i);
  return match?.[0]?.replace(/[.,;]+$/, "");
}

/**
 * Poll mail.tm until a message arrives and is relayed, or timeout.
 *
 * @param {{
 *   token: string,
 *   webhookUrl: string,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 * }} options
 */
export async function waitForEmailRelay({ token, webhookUrl, timeoutMs = 300_000, intervalMs = 5000 }) {
  const seen = new Set();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const relayed = await relayNewMailToWebhook({ token, webhookUrl, seen });
    if (relayed.length) return relayed;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for email delivery");
}
