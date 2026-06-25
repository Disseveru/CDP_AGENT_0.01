import { getRedis, isRedisEnabled } from "../redis.js";
import { CONFIG } from "../config.js";
import type { CaptchaTask } from "./types.js";

const TASK_PREFIX = "captcha:task:";

function taskKey(taskId: string): string {
  return `${TASK_PREFIX}${taskId}`;
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

export function captchaSolveUrl(taskId: string, solveToken: string): string {
  const token = encodeURIComponent(solveToken);
  return `${CONFIG.publicUrl}/solve/${taskId}?token=${token}`;
}
