import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { InboxEvent } from "./types.js";

const MAX_EVENTS_PER_INBOX = 200;
const EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INBOX_ID_PATTERN = /^[a-f0-9]{24}$/;

interface InboxRecord {
  inboxId: string;
  secret: string;
  createdAt: string;
  events: InboxEvent[];
}

export class FileStorage {
  /** Serializes read-modify-write per inbox (async fs yields between read and write). */
  private readonly inboxChains = new Map<string, Promise<unknown>>();

  constructor(private readonly dataDir: string) {}

  async init(): Promise<void> {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.accessSync(this.dataDir, fs.constants.W_OK);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async createInbox(): Promise<{ inboxId: string; secret: string; createdAt: string }> {
    const inboxId = crypto.randomBytes(12).toString("hex");
    const secret = crypto.randomBytes(24).toString("hex");
    const createdAt = new Date().toISOString();
    await this.writeInbox({ inboxId, secret, createdAt, events: [] });
    return { inboxId, secret, createdAt };
  }

  async appendEvent(
    inboxId: string,
    event: Omit<InboxEvent, "id" | "receivedAt">,
  ): Promise<InboxEvent> {
    return this.runExclusive(inboxId, async () => {
      this.assertValidInboxId(inboxId);
      const record = await this.readInbox(inboxId);
      if (!record) {
        throw new Error(`Unknown inbox "${inboxId}"`);
      }

      const full: InboxEvent = {
        id: crypto.randomBytes(8).toString("hex"),
        receivedAt: new Date().toISOString(),
        ...event,
      };

      record.events = this.pruneEvents([...record.events, full]);
      await this.writeInbox(record);
      return full;
    });
  }

  async drainInbox(
    inboxId: string,
    secret: string,
  ): Promise<{ drained: number; events: InboxEvent[] }> {
    return this.runExclusive(inboxId, async () => {
      this.assertValidInboxId(inboxId);
      const record = await this.readInbox(inboxId);
      if (!record) {
        throw new Error(`Unknown inbox "${inboxId}"`);
      }
      if (!this.secretsMatch(record.secret, secret)) {
        throw new Error("Invalid inbox secret");
      }

      const events = [...record.events];
      record.events = [];
      await this.writeInbox(record);
      return { drained: events.length, events };
    });
  }

  async removeInboxEventsByIds(
    inboxId: string,
    secret: string,
    eventIds: string[],
  ): Promise<{ removed: number }> {
    return this.runExclusive(inboxId, async () => {
      this.assertValidInboxId(inboxId);
      const record = await this.readInbox(inboxId);
      if (!record) {
        throw new Error(`Unknown inbox "${inboxId}"`);
      }
      if (!this.secretsMatch(record.secret, secret)) {
        throw new Error("Invalid inbox secret");
      }
      if (eventIds.length === 0) {
        return { removed: 0 };
      }

      const remove = new Set(eventIds);
      const before = record.events.length;
      record.events = this.pruneEvents(record.events.filter((event) => !remove.has(event.id)));
      const removed = before - record.events.length;
      await this.writeInbox(record);
      return { removed };
    });
  }

  async peekInbox(
    inboxId: string,
    secret: string,
  ): Promise<{ pending: number; events: InboxEvent[] }> {
    return this.runExclusive(inboxId, async () => {
      this.assertValidInboxId(inboxId);
      const record = await this.readInbox(inboxId);
      if (!record) {
        throw new Error(`Unknown inbox "${inboxId}"`);
      }
      if (!this.secretsMatch(record.secret, secret)) {
        throw new Error("Invalid inbox secret");
      }

      const events = this.pruneEvents(record.events);
      if (events.length !== record.events.length) {
        record.events = events;
        await this.writeInbox(record);
      }

      return { pending: events.length, events };
    });
  }

  async inboxExists(inboxId: string): Promise<boolean> {
    if (!INBOX_ID_PATTERN.test(inboxId)) {
      return false;
    }
    return (await this.readInbox(inboxId)) !== null;
  }

  async inboxStats(
    inboxId: string,
    secret: string,
  ): Promise<{
    pending: number;
    createdAt: string;
    oldestEventAt: string | null;
    newestEventAt: string | null;
  }> {
    return this.runExclusive(inboxId, async () => {
      this.assertValidInboxId(inboxId);
      const record = await this.readInbox(inboxId);
      if (!record) {
        throw new Error(`Unknown inbox "${inboxId}"`);
      }
      if (!this.secretsMatch(record.secret, secret)) {
        throw new Error("Invalid inbox secret");
      }

      const events = this.pruneEvents(record.events);
      if (events.length !== record.events.length) {
        record.events = events;
        await this.writeInbox(record);
      }

      return {
        pending: events.length,
        createdAt: record.createdAt,
        oldestEventAt: events[0]?.receivedAt ?? null,
        newestEventAt: events.at(-1)?.receivedAt ?? null,
      };
    });
  }

  private runExclusive<T>(inboxId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.inboxChains.get(inboxId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.inboxChains.set(inboxId, next);
    return next.finally(() => {
      if (this.inboxChains.get(inboxId) === next) {
        this.inboxChains.delete(inboxId);
      }
    });
  }

  private assertValidInboxId(inboxId: string): void {
    if (!INBOX_ID_PATTERN.test(inboxId)) {
      throw new Error(`Invalid inbox ID "${inboxId}"`);
    }
  }

  private inboxPath(inboxId: string): string {
    this.assertValidInboxId(inboxId);
    const resolved = path.resolve(this.dataDir, `${inboxId}.json`);
    if (!resolved.startsWith(`${this.dataDir}${path.sep}`)) {
      throw new Error(`Invalid inbox ID "${inboxId}"`);
    }
    return resolved;
  }

  private async readInbox(inboxId: string): Promise<InboxRecord | null> {
    try {
      const raw = await fs.promises.readFile(this.inboxPath(inboxId), "utf8");
      return JSON.parse(raw) as InboxRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async writeInbox(record: InboxRecord): Promise<void> {
    await fs.promises.mkdir(this.dataDir, { recursive: true });
    await fs.promises.writeFile(this.inboxPath(record.inboxId), JSON.stringify(record, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private pruneEvents(events: InboxEvent[]): InboxEvent[] {
    const cutoff = Date.now() - EVENT_TTL_MS;
    return events
      .filter((event) => new Date(event.receivedAt).getTime() > cutoff)
      .slice(-MAX_EVENTS_PER_INBOX);
  }

  private secretsMatch(expected: string, provided: string): boolean {
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length) {
      crypto.timingSafeEqual(a, a);
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  }
}
