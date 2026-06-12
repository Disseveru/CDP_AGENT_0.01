/**
 * AgentWire inbox operations exposed as MCP tools.
 */
import { CONFIG } from "./config.js";
import * as store from "./store.js";

export function createInbox(): {
  inboxId: string;
  secret: string;
  createdAt: string;
  webhookUrl: string;
  usage: string;
} {
  const created = store.createInbox();
  return {
    ...created,
    webhookUrl: `${CONFIG.publicUrl}/hooks/${created.inboxId}`,
    usage:
      "POST JSON to webhookUrl from Stripe, GitHub, humans, or any service. " +
      "Call drain_inbox with inboxId + secret to pull events into your agent loop.",
  };
}

export function drainInbox(input: { inboxId: string; secret: string }) {
  const result = store.drainInbox(input.inboxId, input.secret);
  return {
    timestamp: new Date().toISOString(),
    inboxId: input.inboxId,
    drained: result.drained,
    events: result.events,
  };
}

export function peekInbox(input: { inboxId: string; secret: string }) {
  const result = store.peekInbox(input.inboxId, input.secret);
  return {
    timestamp: new Date().toISOString(),
    inboxId: input.inboxId,
    pending: result.pending,
    events: result.events,
  };
}
