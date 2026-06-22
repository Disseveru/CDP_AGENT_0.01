import { getRedis } from "../redis.js";
import { CONFIG } from "../config.js";
import type { CaptchaTask } from "./types.js";

const TASK_PREFIX = "captcha:task:";

function taskKey(taskId: string): string {
  return `${TASK_PREFIX}${taskId}`;
}

export async function saveCaptchaTask(task: CaptchaTask): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis is required for CAPTCHA task storage (set REDIS_URL)");
  if (redis.status !== "ready") await redis.connect();
  await redis.set(taskKey(task.task_id), JSON.stringify(task), "EX", CONFIG.captcha.taskTtlSec);
}

export async function getCaptchaTask(taskId: string): Promise<CaptchaTask | null> {
  const redis = getRedis();
  if (!redis) return null;
  if (redis.status !== "ready") await redis.connect();
  const raw = await redis.get(taskKey(taskId));
  return raw ? (JSON.parse(raw) as CaptchaTask) : null;
}

export function captchaSolveUrl(taskId: string): string {
  return `${CONFIG.publicUrl}/solve/${taskId}`;
}
