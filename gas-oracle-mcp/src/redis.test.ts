import assert from "node:assert/strict";
import test from "node:test";

import {
  allowMemoryRateLimitedRequest,
  allowRateLimitedRequest,
  resetMemoryRateLimits,
  resetRedisClientForTests,
} from "./redis.js";

test("allowMemoryRateLimitedRequest enforces fixed-window limits", () => {
  resetMemoryRateLimits();
  const now = 1_700_000_000_000;

  assert.equal(allowMemoryRateLimitedRequest("hook", "1.2.3.4", 2, 60, now), true);
  assert.equal(allowMemoryRateLimitedRequest("hook", "1.2.3.4", 2, 60, now + 1), true);
  assert.equal(allowMemoryRateLimitedRequest("hook", "1.2.3.4", 2, 60, now + 2), false);
  assert.equal(allowMemoryRateLimitedRequest("hook", "1.2.3.4", 2, 60, now + 61_000), true);
});

test("Render production webhooks use in-memory fallback when Redis is disabled", async () => {
  resetMemoryRateLimits();
  resetRedisClientForTests();
  const previous = {
    REDIS_URL: process.env.REDIS_URL,
    RENDER: process.env.RENDER,
    RENDER_SERVICE_TYPE: process.env.RENDER_SERVICE_TYPE,
    RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT,
  };

  delete process.env.REDIS_URL;
  process.env.RENDER = "true";
  process.env.RENDER_SERVICE_TYPE = "web";
  delete process.env.RAILWAY_ENVIRONMENT;

  try {
    assert.equal(await allowRateLimitedRequest("hook", "9.9.9.9", 1, 60), true);
    assert.equal(await allowRateLimitedRequest("hook", "9.9.9.9", 1, 60), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetMemoryRateLimits();
    resetRedisClientForTests();
  }
});

test("Render production CAPTCHA stays fail-closed when Redis is disabled", async () => {
  resetRedisClientForTests();
  const previous = {
    REDIS_URL: process.env.REDIS_URL,
    RENDER: process.env.RENDER,
    RENDER_SERVICE_TYPE: process.env.RENDER_SERVICE_TYPE,
  };

  delete process.env.REDIS_URL;
  process.env.RENDER = "true";
  process.env.RENDER_SERVICE_TYPE = "web";

  try {
    assert.equal(await allowRateLimitedRequest("captcha", "9.9.9.9", 30, 60), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetRedisClientForTests();
  }
});

test("denies rate-limited requests on managed production when Redis is disabled", async () => {
  const previousRedis = process.env.REDIS_URL;
  const previousRailway = process.env.RAILWAY_ENVIRONMENT;
  const previousRender = process.env.RENDER;
  const previousRenderType = process.env.RENDER_SERVICE_TYPE;

  delete process.env.REDIS_URL;
  process.env.RAILWAY_ENVIRONMENT = "production";
  delete process.env.RENDER;
  delete process.env.RENDER_SERVICE_TYPE;

  try {
    assert.equal(await allowRateLimitedRequest("test", "127.0.0.1", 30, 60), false);
  } finally {
    if (previousRedis === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = previousRedis;
    }
    if (previousRailway === undefined) {
      delete process.env.RAILWAY_ENVIRONMENT;
    } else {
      process.env.RAILWAY_ENVIRONMENT = previousRailway;
    }
    if (previousRender === undefined) {
      delete process.env.RENDER;
    } else {
      process.env.RENDER = previousRender;
    }
    if (previousRenderType === undefined) {
      delete process.env.RENDER_SERVICE_TYPE;
    } else {
      process.env.RENDER_SERVICE_TYPE = previousRenderType;
    }
    resetRedisClientForTests();
  }
});

test("allows rate-limited requests in non-production when Redis is disabled", async () => {
  const previousRedis = process.env.REDIS_URL;
  const previousRailway = process.env.RAILWAY_ENVIRONMENT;

  delete process.env.REDIS_URL;
  delete process.env.RAILWAY_ENVIRONMENT;

  try {
    assert.equal(await allowRateLimitedRequest("test", "127.0.0.1", 30, 60), true);
  } finally {
    if (previousRedis === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = previousRedis;
    }
    if (previousRailway === undefined) {
      delete process.env.RAILWAY_ENVIRONMENT;
    } else {
      process.env.RAILWAY_ENVIRONMENT = previousRailway;
    }
    resetRedisClientForTests();
  }
});
