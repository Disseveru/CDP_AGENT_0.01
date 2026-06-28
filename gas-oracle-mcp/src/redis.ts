import { Redis } from "ioredis";

import { isManagedProductionDeploy } from "./deploy-env.js";

let client: Redis | null = null;

/** Per-process fallback when Redis is unavailable (e.g. Render free tier without Upstash). */
const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

export function isRedisEnabled(): boolean {
  return Boolean(process.env.REDIS_URL?.trim());
}

export function getRedis(): Redis | null {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    return null;
  }
  if (!client) {
    client = new Redis(redisUrl, {
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

/** Fixed-window limiter backed by an in-memory map (single instance only). */
export function allowMemoryRateLimitedRequest(
  category: string,
  key: string,
  limit: number,
  windowSec: number,
  nowMs = Date.now(),
): boolean {
  const bucketKey = `${category}:${key}`;
  const existing = memoryBuckets.get(bucketKey);
  const resetAt = nowMs + windowSec * 1000;

  if (!existing || nowMs >= existing.resetAt) {
    memoryBuckets.set(bucketKey, { count: 1, resetAt });
    return true;
  }

  existing.count += 1;
  return existing.count <= limit;
}

/** Reset in-memory buckets and Redis client — test helper only. */
export function resetMemoryRateLimits(): void {
  memoryBuckets.clear();
}

export function resetRedisClientForTests(): void {
  client = null;
}

function shouldUseMemoryFallback(category: string): boolean {
  // Webhooks are core on Render without optional Upstash Redis (see docs/RENDER-DEPLOY.md).
  // CAPTCHA already requires REDIS_URL for task storage; keep fail-closed there.
  return category === "hook";
}

function handleUnavailableRateLimit(
  category: string,
  key: string,
  limit: number,
  windowSec: number,
  reason: string,
): boolean {
  if (!isManagedProductionDeploy()) {
    if (reason === "missing") {
      return true;
    }
    console.warn(`[redis] Rate limit check failed (${category}), allowing request`);
    return true;
  }

  if (shouldUseMemoryFallback(category)) {
    console.warn(
      `[redis] Rate limit ${reason} in production (${category}), using in-memory fallback`,
    );
    return allowMemoryRateLimitedRequest(category, key, limit, windowSec);
  }

  console.warn(`[redis] Rate limit ${reason} in production (${category}), denying request`);
  return false;
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
    return handleUnavailableRateLimit(category, key, limit, windowSec, "unavailable");
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
    if (isManagedProductionDeploy() && shouldUseMemoryFallback(category)) {
      console.warn(
        `[redis] Rate limit check failed in production (${category}), using in-memory fallback:`,
        error,
      );
      return allowMemoryRateLimitedRequest(category, key, limit, windowSec);
    }
    return handleUnavailableRateLimit(category, key, limit, windowSec, "check failed");
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
