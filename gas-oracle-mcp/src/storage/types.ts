export interface InboxEvent {
  id: string;
  receivedAt: string;
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface StorageHealth {
  backend: "file" | "postgres";
  ok: boolean;
  detail?: string;
}
