import { Redis } from "ioredis";

import { CONFIG } from "./config.js";

let client: Redis | null = null;

export function isRedisEnabled(): boolean {
  return Boolean(CONFIG.redisUrl);
}

export function getRedis(): Redis | null {
  if (!CONFIG.redisUrl) {
    return null;
  }
  if (!client) {
    client = new Redis(CONFIG.redisUrl, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
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
    console.warn(`[redis] Rate limit check failed (${category}), allowing request:`, error);
    return true;
  }
}

/** Fixed-window rate limiter for webhook ingestion. */
export async function allowWebhookRequest(key: string, limit: number, windowSec: number): Promise<boolean> {
  return allowRateLimitedRequest("hook", key, limit, windowSec);
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
