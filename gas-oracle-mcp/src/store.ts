import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG } from "./config.js";
import { FileStorage } from "./storage/file.js";
import { PostgresStorage } from "./storage/postgres.js";
import type { InboxEvent, StorageHealth } from "./storage/types.js";

export type { InboxEvent, StorageHealth };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultDataDir = path.join(__dirname, "..", "data", "inboxes");

type StorageAdapter = FileStorage | PostgresStorage;

let adapter: StorageAdapter | null = null;
let initPromise: Promise<void> | null = null;

function resolveBackend(): "file" | "postgres" {
  if (CONFIG.storageBackend === "file") {
    return "file";
  }
  if (CONFIG.storageBackend === "postgres" || CONFIG.databaseUrl) {
    return "postgres";
  }
  return "file";
}

async function getAdapter(): Promise<StorageAdapter> {
  if (adapter) {
    return adapter;
  }

  if (!initPromise) {
    initPromise = (async () => {
      if (resolveBackend() === "postgres") {
        const { getPool } = await import("./db.js");
        adapter = new PostgresStorage(getPool());
      } else {
        adapter = new FileStorage(CONFIG.dataDir || defaultDataDir);
      }
      await adapter.init();
    })();
  }

  await initPromise;
  if (!adapter) {
    throw new Error("Storage adapter failed to initialize");
  }
  return adapter;
}

export async function initializeStorage(): Promise<void> {
  await getAdapter();
}

export async function getStorageHealth(): Promise<StorageHealth> {
  try {
    const current = await getAdapter();
    const health = await current.health();
    return {
      backend: resolveBackend(),
      ok: health.ok,
      detail: health.detail,
    };
  } catch (error) {
    return {
      backend: resolveBackend(),
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createInbox(): Promise<{ inboxId: string; secret: string; createdAt: string }> {
  return (await getAdapter()).createInbox();
}

export async function appendEvent(
  inboxId: string,
  event: Omit<InboxEvent, "id" | "receivedAt">,
): Promise<InboxEvent> {
  return (await getAdapter()).appendEvent(inboxId, event);
}

export async function drainInbox(
  inboxId: string,
  secret: string,
): Promise<{ drained: number; events: InboxEvent[] }> {
  return (await getAdapter()).drainInbox(inboxId, secret);
}

export async function removeInboxEventsByIds(
  inboxId: string,
  secret: string,
  eventIds: string[],
): Promise<{ removed: number }> {
  return (await getAdapter()).removeInboxEventsByIds(inboxId, secret, eventIds);
}

export async function peekInbox(
  inboxId: string,
  secret: string,
): Promise<{ pending: number; events: InboxEvent[] }> {
  return (await getAdapter()).peekInbox(inboxId, secret);
}

export async function inboxExists(inboxId: string): Promise<boolean> {
  return (await getAdapter()).inboxExists(inboxId);
}

export async function inboxStats(
  inboxId: string,
  secret: string,
): Promise<{
  pending: number;
  createdAt: string;
  oldestEventAt: string | null;
  newestEventAt: string | null;
}> {
  return (await getAdapter()).inboxStats(inboxId, secret);
}
