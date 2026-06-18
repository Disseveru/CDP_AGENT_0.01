/**
 * Durable inbox storage for AgentWire webhook relay.
 *
 * Each inbox is a JSON file under data/inboxes/. Events persist across
 * server restarts so deployed agents can rely on this as real infrastructure.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data", "inboxes");

const MAX_EVENTS_PER_INBOX = 200;
const EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const INBOX_ID_PATTERN = /^[a-f0-9]{24}$/;

function assertValidInboxId(inboxId: string): void {
  if (!INBOX_ID_PATTERN.test(inboxId)) {
    throw new Error(`Invalid inbox ID "${inboxId}"`);
  }
}

function secretsMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export interface InboxEvent {
  id: string;
  receivedAt: string;
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

interface InboxRecord {
  inboxId: string;
  secret: string;
  createdAt: string;
  events: InboxEvent[];
}

function inboxPath(inboxId: string): string {
  assertValidInboxId(inboxId);
  const resolved = path.resolve(DATA_DIR, `${inboxId}.json`);
  if (!resolved.startsWith(`${DATA_DIR}${path.sep}`)) {
    throw new Error(`Invalid inbox ID "${inboxId}"`);
  }
  return resolved;
}

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readInbox(inboxId: string): InboxRecord | null {
  try {
    const raw = fs.readFileSync(inboxPath(inboxId), "utf8");
    return JSON.parse(raw) as InboxRecord;
  } catch {
    return null;
  }
}

function writeInbox(record: InboxRecord): void {
  ensureDataDir();
  fs.writeFileSync(inboxPath(record.inboxId), JSON.stringify(record, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function pruneEvents(events: InboxEvent[]): InboxEvent[] {
  const cutoff = Date.now() - EVENT_TTL_MS;
  return events
    .filter((e) => new Date(e.receivedAt).getTime() > cutoff)
    .slice(-MAX_EVENTS_PER_INBOX);
}

export function createInbox(): { inboxId: string; secret: string; createdAt: string } {
  const inboxId = crypto.randomBytes(12).toString("hex");
  const secret = crypto.randomBytes(24).toString("hex");
  const createdAt = new Date().toISOString();

  writeInbox({ inboxId, secret, createdAt, events: [] });
  return { inboxId, secret, createdAt };
}

export function appendEvent(
  inboxId: string,
  event: Omit<InboxEvent, "id" | "receivedAt">,
): InboxEvent {
  assertValidInboxId(inboxId);
  const record = readInbox(inboxId);
  if (!record) {
    throw new Error(`Unknown inbox "${inboxId}"`);
  }

  const full: InboxEvent = {
    id: crypto.randomBytes(8).toString("hex"),
    receivedAt: new Date().toISOString(),
    ...event,
  };

  record.events = pruneEvents([...record.events, full]);
  writeInbox(record);
  return full;
}

export function drainInbox(
  inboxId: string,
  secret: string,
): { drained: number; events: InboxEvent[] } {
  assertValidInboxId(inboxId);
  const record = readInbox(inboxId);
  if (!record) {
    throw new Error(`Unknown inbox "${inboxId}"`);
  }
  if (!secretsMatch(record.secret, secret)) {
    throw new Error("Invalid inbox secret");
  }

  const events = [...record.events];
  record.events = [];
  writeInbox(record);
  return { drained: events.length, events };
}

/**
 * Removes specific inbox events after a paid drain settles successfully.
 * Keeps any events that arrived after the peek snapshot.
 */
export function removeInboxEventsByIds(
  inboxId: string,
  secret: string,
  eventIds: string[],
): { removed: number } {
  assertValidInboxId(inboxId);
  const record = readInbox(inboxId);
  if (!record) {
    throw new Error(`Unknown inbox "${inboxId}"`);
  }
  if (!secretsMatch(record.secret, secret)) {
    throw new Error("Invalid inbox secret");
  }

  if (eventIds.length === 0) {
    return { removed: 0 };
  }

  const remove = new Set(eventIds);
  const before = record.events.length;
  record.events = pruneEvents(record.events.filter((event) => !remove.has(event.id)));
  const removed = before - record.events.length;
  writeInbox(record);
  return { removed };
}

export function peekInbox(
  inboxId: string,
  secret: string,
): { pending: number; events: InboxEvent[] } {
  assertValidInboxId(inboxId);
  const record = readInbox(inboxId);
  if (!record) {
    throw new Error(`Unknown inbox "${inboxId}"`);
  }
  if (!secretsMatch(record.secret, secret)) {
    throw new Error("Invalid inbox secret");
  }

  const events = pruneEvents(record.events);
  if (events.length !== record.events.length) {
    record.events = events;
    writeInbox(record);
  }

  return { pending: events.length, events };
}

export function inboxExists(inboxId: string): boolean {
  if (!INBOX_ID_PATTERN.test(inboxId)) {
    return false;
  }
  return readInbox(inboxId) !== null;
}

export function inboxStats(
  inboxId: string,
  secret: string,
): {
  pending: number;
  createdAt: string;
  oldestEventAt: string | null;
  newestEventAt: string | null;
} {
  assertValidInboxId(inboxId);
  const record = readInbox(inboxId);
  if (!record) {
    throw new Error(`Unknown inbox "${inboxId}"`);
  }
  if (!secretsMatch(record.secret, secret)) {
    throw new Error("Invalid inbox secret");
  }

  const events = pruneEvents(record.events);
  if (events.length !== record.events.length) {
    record.events = events;
    writeInbox(record);
  }

  return {
    pending: events.length,
    createdAt: record.createdAt,
    oldestEventAt: events[0]?.receivedAt ?? null,
    newestEventAt: events.at(-1)?.receivedAt ?? null,
  };
}
