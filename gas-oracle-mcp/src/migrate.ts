import { closePool, getPool } from "./db.js";

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS agentwire_inboxes (
  inbox_id CHAR(24) PRIMARY KEY,
  secret TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agentwire_inbox_events (
  id CHAR(16) PRIMARY KEY,
  inbox_id CHAR(24) NOT NULL REFERENCES agentwire_inboxes(inbox_id) ON DELETE CASCADE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  method TEXT NOT NULL,
  headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  query JSONB NOT NULL DEFAULT '{}'::jsonb,
  body JSONB
);

CREATE INDEX IF NOT EXISTS idx_agentwire_events_inbox_received
  ON agentwire_inbox_events(inbox_id, received_at);
`;

export async function runMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) {
    console.log("[migrate] DATABASE_URL unset — skipping schema migration");
    return;
  }
  const pool = getPool();
  await pool.query(MIGRATION_SQL);
  console.log("[migrate] AgentWire schema ready");
}

import { pathToFileURL } from "node:url";

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runMigrations()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch((error) => {
      console.error("[migrate] Failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
