import { Redis } from "ioredis";

import { CONFIG } from "./config.js";

let client: Redis | null = null;
let connectedUrl: string | undefined;

function resolveRedisUrl(): string | undefined {
  return process.env.REDIS_URL?.trim() || CONFIG.redisUrl;
}

export function isRedisEnabled(): boolean {
  return Boolean(resolveRedisUrl());
}

export function getRedis(): Redis | null {
  const redisUrl = resolveRedisUrl();
  if (!redisUrl) {
    return null;
  }
  if (client && connectedUrl !== redisUrl) {
    void client.quit();
    client = null;
  }
  if (!client) {
    client = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 1000,
      retryStrategy: () => null,
    });
    connectedUrl = redisUrl;
  }
  return client;
}

export async function getRedisHealth(): Promise<{ ok: boolean; detail?: string }> {
  const redis = getRedis();
  if (!redis) {
    return { ok: false, detail: "disabled" };
  }

  try {
    if (redis.status !== "ready") {
      await redis.connect();
    }
    const pong = await redis.ping();
    return { ok: pong === "PONG" };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Simple fixed-window rate limiter for webhook ingestion.
 * Returns true when the request should be allowed.
 */
export async function allowRateLimitedRequest(
  category: string,
  key: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    if (process.env.RAILWAY_ENVIRONMENT === "production") {
      console.warn(`[redis] Rate limit unavailable in production (${category}), denying request`);
      return false;
    }
    return true;
  }

  try {
    if (redis.status !== "ready") {
      await redis.connect();
    }

    const bucket = `agentwire:ratelimit:${category}:${key}`;
    const count = await redis.incr(bucket);
    if (count === 1) {
      await redis.expire(bucket, windowSec);
    }
    return count <= limit;
  } catch (error) {
    if (process.env.RAILWAY_ENVIRONMENT === "production") {
      console.warn(`[redis] Rate limit check failed (${category}), denying request:`, error);
      return false;
    }
    console.warn(`[redis] Rate limit check failed (${category}), allowing request:`, error);
    return true;
  }
}

const DRAIN_LOCK_PREFIX = "agentwire:drain-lock:";

/** Serialize drain_inbox peeks per inbox so concurrent drains cannot double-charge. */
export async function acquireInboxDrainLock(inboxId: string, ttlSec: number): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    if (process.env.RAILWAY_ENVIRONMENT === "production") {
      console.warn(`[redis] Inbox drain lock unavailable in production, denying drain`);
      return false;
    }
    return true;
  }

  try {
    if (redis.status !== "ready") {
      await redis.connect();
    }
    const result = await redis.set(`${DRAIN_LOCK_PREFIX}${inboxId}`, "1", "EX", ttlSec, "NX");
    return result === "OK";
  } catch (error) {
    if (process.env.RAILWAY_ENVIRONMENT === "production") {
      console.warn(`[redis] Inbox drain lock failed for ${inboxId}, denying drain:`, error);
      return false;
    }
    console.warn(`[redis] Inbox drain lock failed for ${inboxId}, allowing drain:`, error);
    return true;
  }
}

export async function releaseInboxDrainLock(inboxId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    return;
  }

  try {
    if (redis.status !== "ready") {
      await redis.connect();
    }
    await redis.del(`${DRAIN_LOCK_PREFIX}${inboxId}`);
  } catch (error) {
    console.warn(`[redis] Failed to release inbox drain lock for ${inboxId}:`, error);
  }
}

/** Fixed-window rate limiter for webhook ingestion. */
export async function allowWebhookRequest(key: string, limit: number, windowSec: number): Promise<boolean> {
  return allowRateLimitedRequest("hook", key, limit, windowSec);
}

export async function closeRedis(): Promise<void> {
  if (!client) {
    return;
  }

  try {
    if (client.status === "ready") {
      await client.quit();
    } else {
      client.disconnect();
    }
  } catch {
    client.disconnect();
  } finally {
    client = null;
    connectedUrl = undefined;
  }
}
