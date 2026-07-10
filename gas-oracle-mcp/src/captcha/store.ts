import crypto from "node:crypto";

import { getRedis, isRedisEnabled } from "../redis.js";
import { CONFIG } from "../config.js";
import type { CaptchaSubmitInput, CaptchaTask } from "./types.js";

const TASK_PREFIX = "captcha:task:";
const DEDUP_PREFIX = "captcha:dedup:";

function taskKey(taskId: string): string {
  return `${TASK_PREFIX}${taskId}`;
}

function captchaDedupKey(input: CaptchaSubmitInput): string {
  return crypto
    .createHash("sha256")
    .update(`${input.pageurl}|${input.sitekey}|${input.captcha_type}`)
    .digest("hex");
}

function dedupKey(input: CaptchaSubmitInput): string {
  return `${DEDUP_PREFIX}${captchaDedupKey(input)}`;
}

export function isCaptchaStorageConfigured(): boolean {
  return isRedisEnabled();
}

export async function assertCaptchaStorageReady(): Promise<void> {
  if (!isRedisEnabled()) {
    throw new Error("CAPTCHA storage unavailable: set REDIS_URL on Railway");
  }
  const redis = getRedis();
  if (!redis) {
    throw new Error("CAPTCHA storage unavailable: Redis client failed to initialize");
  }
  if (redis.status !== "ready") {
    await redis.connect();
  }
  const pong = await redis.ping();
  if (pong !== "PONG") {
    throw new Error("CAPTCHA storage unavailable: Redis ping failed");
  }
}

export async function saveCaptchaTask(task: CaptchaTask): Promise<void> {
  await assertCaptchaStorageReady();
  const redis = getRedis()!;
  await redis.set(taskKey(task.task_id), JSON.stringify(task), "EX", CONFIG.captcha.taskTtlSec);
}

export async function getCaptchaTask(taskId: string): Promise<CaptchaTask | null> {
  if (!isRedisEnabled()) return null;
  const redis = getRedis();
  if (!redis) return null;
  if (redis.status !== "ready") await redis.connect();
  const raw = await redis.get(taskKey(taskId));
  return raw ? (JSON.parse(raw) as CaptchaTask) : null;
}

export async function deleteCaptchaTask(taskId: string): Promise<void> {
  if (!isRedisEnabled()) return;
  const redis = getRedis();
  if (!redis) return;
  if (redis.status !== "ready") await redis.connect();
  await redis.del(taskKey(taskId));
}

/** Reuse an in-flight task for the same target page to avoid duplicate operator alerts. */
export async function findPendingCaptchaByInput(
  input: CaptchaSubmitInput,
): Promise<CaptchaTask | null> {
  if (!isRedisEnabled()) return null;
  const redis = getRedis();
  if (!redis) return null;
  if (redis.status !== "ready") await redis.connect();
  const taskId = await redis.get(dedupKey(input));
  if (!taskId) return null;
  const task = await getCaptchaTask(taskId);
  if (!task || task.status !== "pending") {
    await redis.del(dedupKey(input));
    return null;
  }
  return task;
}

export async function linkCaptchaDedupKey(
  input: CaptchaSubmitInput,
  taskId: string,
): Promise<void> {
  await assertCaptchaStorageReady();
  const redis = getRedis()!;
  await redis.set(dedupKey(input), taskId, "EX", CONFIG.captcha.taskTtlSec);
}

export function captchaSolveUrl(taskId: string, solveToken: string): string {
  const token = encodeURIComponent(solveToken);
  return `${CONFIG.publicUrl}/solve/${taskId}?token=${token}`;
}
