import assert from "node:assert/strict";
import test from "node:test";

import { allowRateLimitedRequest } from "./redis.js";

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
  }
});
