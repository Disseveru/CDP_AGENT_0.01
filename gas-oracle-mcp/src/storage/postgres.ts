import crypto from "node:crypto";

import type { Pool } from "pg";

import type { InboxEvent } from "./types.js";

const MAX_EVENTS_PER_INBOX = 200;
const EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INBOX_ID_PATTERN = /^[a-f0-9]{24}$/;

export class PostgresStorage {
  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.pool.query("SELECT 1");
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

    await this.pool.query(
      `INSERT INTO agentwire_inboxes (inbox_id, secret, created_at)
       VALUES ($1, $2, $3)`,
      [inboxId, secret, createdAt],
    );

    return { inboxId, secret, createdAt };
  }

  async appendEvent(
    inboxId: string,
    event: Omit<InboxEvent, "id" | "receivedAt">,
  ): Promise<InboxEvent> {
    this.assertValidInboxId(inboxId);
    const exists = await this.pool.query(
      "SELECT 1 FROM agentwire_inboxes WHERE inbox_id = $1",
      [inboxId],
    );
    if (exists.rowCount === 0) {
      throw new Error(`Unknown inbox "${inboxId}"`);
    }

    const full: InboxEvent = {
      id: crypto.randomBytes(8).toString("hex"),
      receivedAt: new Date().toISOString(),
      ...event,
    };

    await this.pool.query(
      `INSERT INTO agentwire_inbox_events
         (id, inbox_id, received_at, method, headers, query, body)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
      [
        full.id,
        inboxId,
        full.receivedAt,
        full.method,
        JSON.stringify(full.headers),
        JSON.stringify(full.query),
        JSON.stringify(full.body),
      ],
    );

    await this.pruneInbox(inboxId);
    return full;
  }

  async drainInbox(
    inboxId: string,
    secret: string,
  ): Promise<{ drained: number; events: InboxEvent[] }> {
    await this.requireSecret(inboxId, secret);
    const events = await this.loadEvents(inboxId);
    await this.pool.query("DELETE FROM agentwire_inbox_events WHERE inbox_id = $1", [inboxId]);
    return { drained: events.length, events };
  }

  async removeInboxEventsByIds(
    inboxId: string,
    secret: string,
    eventIds: string[],
  ): Promise<{ removed: number }> {
    await this.requireSecret(inboxId, secret);
    if (eventIds.length === 0) {
      return { removed: 0 };
    }

    const result = await this.pool.query(
      `DELETE FROM agentwire_inbox_events
       WHERE inbox_id = $1 AND id = ANY($2::text[])`,
      [inboxId, eventIds],
    );
    await this.pruneInbox(inboxId);
    return { removed: result.rowCount ?? 0 };
  }

  async peekInbox(
    inboxId: string,
    secret: string,
  ): Promise<{ pending: number; events: InboxEvent[] }> {
    await this.requireSecret(inboxId, secret);
    await this.pruneInbox(inboxId);
    const events = await this.loadEvents(inboxId);
    return { pending: events.length, events };
  }

  async inboxExists(inboxId: string): Promise<boolean> {
    if (!INBOX_ID_PATTERN.test(inboxId)) {
      return false;
    }
    const result = await this.pool.query(
      "SELECT 1 FROM agentwire_inboxes WHERE inbox_id = $1",
      [inboxId],
    );
    return (result.rowCount ?? 0) > 0;
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
    await this.requireSecret(inboxId, secret);
    await this.pruneInbox(inboxId);

    const inbox = await this.pool.query<{ created_at: string }>(
      "SELECT created_at FROM agentwire_inboxes WHERE inbox_id = $1",
      [inboxId],
    );
    const events = await this.loadEvents(inboxId);

    return {
      pending: events.length,
      createdAt: inbox.rows[0].created_at,
      oldestEventAt: events[0]?.receivedAt ?? null,
      newestEventAt: events.at(-1)?.receivedAt ?? null,
    };
  }

  private assertValidInboxId(inboxId: string): void {
    if (!INBOX_ID_PATTERN.test(inboxId)) {
      throw new Error(`Invalid inbox ID "${inboxId}"`);
    }
  }

  private async requireSecret(inboxId: string, secret: string): Promise<void> {
    this.assertValidInboxId(inboxId);
    const result = await this.pool.query<{ secret: string }>(
      "SELECT secret FROM agentwire_inboxes WHERE inbox_id = $1",
      [inboxId],
    );
    if (result.rowCount === 0) {
      throw new Error(`Unknown inbox "${inboxId}"`);
    }
    if (!this.secretsMatch(result.rows[0].secret, secret)) {
      throw new Error("Invalid inbox secret");
    }
  }

  private async loadEvents(inboxId: string): Promise<InboxEvent[]> {
    const result = await this.pool.query<{
      id: string;
      received_at: string;
      method: string;
      headers: Record<string, string>;
      query: Record<string, string>;
      body: unknown;
    }>(
      `SELECT id, received_at, method, headers, query, body
       FROM agentwire_inbox_events
       WHERE inbox_id = $1
       ORDER BY received_at ASC`,
      [inboxId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      receivedAt: new Date(row.received_at).toISOString(),
      method: row.method,
      headers: row.headers,
      query: row.query,
      body: row.body,
    }));
  }

  private async pruneInbox(inboxId: string): Promise<void> {
    const cutoff = new Date(Date.now() - EVENT_TTL_MS).toISOString();
    await this.pool.query(
      "DELETE FROM agentwire_inbox_events WHERE inbox_id = $1 AND received_at < $2",
      [inboxId, cutoff],
    );

    await this.pool.query(
      `DELETE FROM agentwire_inbox_events
       WHERE inbox_id = $1
         AND id IN (
           SELECT id FROM agentwire_inbox_events
           WHERE inbox_id = $1
           ORDER BY received_at DESC
           OFFSET $2
         )`,
      [inboxId, MAX_EVENTS_PER_INBOX],
    );
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
