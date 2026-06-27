import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireInboxDrainLock,
  allowRateLimitedRequest,
  closeRedis,
  releaseInboxDrainLock,
} from "./redis.js";

async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await fn();
  } finally {
    await closeRedis();
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("allowRateLimitedRequest denies when redis is disabled in production", async () => {
  await withEnv({ REDIS_URL: undefined, RAILWAY_ENVIRONMENT: "production" }, async () => {
    const allowed = await allowRateLimitedRequest("hook", "127.0.0.1", 30, 60);
    assert.equal(allowed, false);
  });
});

test("allowRateLimitedRequest allows when redis is disabled outside production", async () => {
  await withEnv({ REDIS_URL: undefined, RAILWAY_ENVIRONMENT: undefined }, async () => {
    const allowed = await allowRateLimitedRequest("hook", "127.0.0.1", 30, 60);
    assert.equal(allowed, true);
  });
});

test("allowRateLimitedRequest denies when redis errors in production", async () => {
  await withEnv(
    { REDIS_URL: "redis://127.0.0.1:59999", RAILWAY_ENVIRONMENT: "production" },
    async () => {
      const allowed = await allowRateLimitedRequest("hook", "127.0.0.1", 30, 60);
      assert.equal(allowed, false);
    },
  );
});

test("acquireInboxDrainLock denies when redis is disabled in production", async () => {
  await withEnv({ REDIS_URL: undefined, RAILWAY_ENVIRONMENT: "production" }, async () => {
    const acquired = await acquireInboxDrainLock("abc123", 60);
    assert.equal(acquired, false);
  });
});

test("acquireInboxDrainLock serializes concurrent drains for the same inbox", async () => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return;
  }

  const inboxId = `test-${Date.now()}`;
  try {
    assert.equal(await acquireInboxDrainLock(inboxId, 30), true);
    assert.equal(await acquireInboxDrainLock(inboxId, 30), false);
  } finally {
    await releaseInboxDrainLock(inboxId);
    await closeRedis();
  }
});
