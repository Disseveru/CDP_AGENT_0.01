import crypto from "node:crypto";
import { z } from "zod";

import { captchaSolveUrl, getCaptchaTask, saveCaptchaTask, assertCaptchaStorageReady } from "./store.js";
import { notifyOperator } from "./notifications.js";
import type {
  CaptchaSubmitInput,
  CaptchaSubmitResult,
  CaptchaStatusResult,
  CaptchaTask,
  CaptchaType,
} from "./types.js";
import { CONFIG } from "../config.js";

const captchaTypeSchema = z.enum(["recaptcha", "hcaptcha", "turnstile"]);

export const submitBodySchema = z.object({
  sitekey: z.string().min(1),
  pageurl: z.string().url(),
  captcha_type: captchaTypeSchema,
});

export function parseSubmitBody(body: unknown): CaptchaSubmitInput {
  return submitBodySchema.parse(body);
}

export async function createCaptchaTask(
  input: CaptchaSubmitInput,
  options?: { notify?: boolean; paymentTx?: string },
): Promise<CaptchaSubmitResult> {
  await assertCaptchaStorageReady();

  const taskId = crypto.randomUUID();
  const task: CaptchaTask = {
    task_id: taskId,
    sitekey: input.sitekey,
    pageurl: input.pageurl,
    captcha_type: input.captcha_type,
    status: "pending",
    created_at: new Date().toISOString(),
    payment_tx: options?.paymentTx,
  };

  await saveCaptchaTask(task);

  const solveUrl = captchaSolveUrl(taskId);
  const result = { task_id: taskId, status: "pending" as const, solve_url: solveUrl };

  if (options?.notify !== false) {
    void notifyOperator({
      taskId,
      solveUrl,
      captchaType: input.captcha_type,
      pageUrl: input.pageurl,
    }).catch((error) => {
      console.error("[captcha] Operator alert failed:", error);
    });
  }

  return result;
}

export async function getCaptchaStatus(taskId: string): Promise<CaptchaStatusResult | null> {
  const task = await getCaptchaTask(taskId);
  if (!task) return null;

  return {
    task_id: task.task_id,
    status: task.status,
    solution_token: task.status === "completed" ? task.solution_token : undefined,
    created_at: task.created_at,
    completed_at: task.completed_at,
  };
}

export async function completeCaptchaTask(
  taskId: string,
  solutionToken: string,
): Promise<CaptchaTask | null> {
  const task = await getCaptchaTask(taskId);
  if (!task) return null;
  if (task.status === "completed") return task;

  const updated: CaptchaTask = {
    ...task,
    status: "completed",
    solution_token: solutionToken,
    completed_at: new Date().toISOString(),
  };
  await saveCaptchaTask(updated);
  return updated;
}

export function captchaWidgetScript(type: CaptchaType): { scriptUrl: string; globalName: string } {
  switch (type) {
    case "recaptcha":
      return { scriptUrl: "https://www.google.com/recaptcha/api.js", globalName: "grecaptcha" };
    case "hcaptcha":
      return { scriptUrl: "https://js.hcaptcha.com/1/api.js", globalName: "hcaptcha" };
    case "turnstile":
      return {
        scriptUrl: "https://challenges.cloudflare.com/turnstile/v0/api.js",
        globalName: "turnstile",
      };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until the operator completes the solve page or timeout. */
export async function waitForCaptchaSolution(taskId: string): Promise<CaptchaStatusResult> {
  const deadline = Date.now() + CONFIG.captcha.pollTimeoutMs;

  while (Date.now() < deadline) {
    const status = await getCaptchaStatus(taskId);
    if (!status) {
      throw new Error(`CAPTCHA task ${taskId} not found`);
    }
    if (status.status === "completed" && status.solution_token) {
      return status;
    }
    await sleep(CONFIG.captcha.pollIntervalMs);
  }

  throw new Error(
    `CAPTCHA task ${taskId} timed out after ${CONFIG.captcha.pollTimeoutMs}ms — solve at ${captchaSolveUrl(taskId)}`,
  );
}
