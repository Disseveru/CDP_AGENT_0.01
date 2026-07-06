import crypto from "node:crypto";
import { getFacilitatorResponseError } from "@x402/core/types";
import { z } from "zod";

import { captchaSolveUrl, getCaptchaTask, saveCaptchaTask, assertCaptchaStorageReady } from "./store.js";
import { notifyOperator } from "./notifications.js";
import { generateCaptchaSecret, safeCompareSecret } from "./tokens.js";
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

const FACILITATOR_PARSE_FAILURE =
  /^Facilitator \S+ returned invalid (?:JSON|data)/;

/** Matches facilitator HTTP-200 bodies that failed JSON/schema validation. */
export function isFacilitatorSettlementParseFailureMessage(message: string): boolean {
  return FACILITATOR_PARSE_FAILURE.test(message);
}

/**
 * x402 `processSettlement` rethrows only {@link FacilitatorResponseError}: the
 * facilitator returned HTTP 200 for `/settle` but the body failed JSON/schema
 * validation. That usually means on-chain settlement already succeeded, so the
 * CAPTCHA task must not be rolled back.
 */
export function shouldPreserveCaptchaTaskAfterSettlementError(error: unknown): boolean {
  if (getFacilitatorResponseError(error) !== null) {
    return true;
  }
  if (error instanceof Error && isFacilitatorSettlementParseFailureMessage(error.message)) {
    return true;
  }
  return false;
}

/** MCP `createPaymentWrapper` converts settlement throws into payment-required errors. */
export function shouldPreserveHandlerResultAfterMcpSettlementFailure(result: {
  isError?: boolean;
  content?: { text?: string }[];
}): boolean {
  if (!result.isError) {
    return false;
  }

  const text = result.content?.[0]?.text;
  if (!text) {
    return false;
  }

  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (typeof parsed.error !== "string") {
      return false;
    }

    const facilitatorMessage = parsed.error.startsWith("Payment settlement failed: ")
      ? parsed.error.slice("Payment settlement failed: ".length)
      : parsed.error;
    return shouldPreserveCaptchaTaskAfterSettlementError(new Error(facilitatorMessage));
  } catch {
    return false;
  }
}

export async function createCaptchaTask(
  input: CaptchaSubmitInput,
  options?: { notify?: boolean; paymentTx?: string },
): Promise<CaptchaSubmitResult> {
  await assertCaptchaStorageReady();

  const taskId = crypto.randomUUID();
  const pollToken = generateCaptchaSecret();
  const solveToken = generateCaptchaSecret();
  const task: CaptchaTask = {
    task_id: taskId,
    sitekey: input.sitekey,
    pageurl: input.pageurl,
    captcha_type: input.captcha_type,
    status: "pending",
    poll_token: pollToken,
    solve_token: solveToken,
    created_at: new Date().toISOString(),
    payment_tx: options?.paymentTx,
  };

  await saveCaptchaTask(task);

  const solveUrl = captchaSolveUrl(taskId, solveToken);
  const result = { task_id: taskId, status: "pending" as const, solve_url: solveUrl, poll_token: pollToken };

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

export async function getCaptchaStatus(
  taskId: string,
  pollToken: string,
): Promise<CaptchaStatusResult | null> {
  const task = await getCaptchaTask(taskId);
  if (!task) return null;
  if (!pollToken || !safeCompareSecret(pollToken, task.poll_token)) {
    return null;
  }

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
  solveToken: string,
): Promise<CaptchaTask | null> {
  const task = await getCaptchaTask(taskId);
  if (!task) return null;
  if (!solveToken || !safeCompareSecret(solveToken, task.solve_token)) {
    return null;
  }
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
export async function waitForCaptchaSolution(
  taskId: string,
  pollToken: string,
): Promise<CaptchaStatusResult> {
  const deadline = Date.now() + CONFIG.captcha.pollTimeoutMs;

  while (Date.now() < deadline) {
    const status = await getCaptchaStatus(taskId, pollToken);
    if (!status) {
      throw new Error(`CAPTCHA task ${taskId} not found`);
    }
    if (status.status === "completed" && status.solution_token) {
      return status;
    }
    await sleep(CONFIG.captcha.pollIntervalMs);
  }

  throw new Error(
    `CAPTCHA task ${taskId} timed out after ${CONFIG.captcha.pollTimeoutMs}ms`,
  );
}
